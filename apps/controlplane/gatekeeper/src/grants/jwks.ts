import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { JwksUri } from '../config/schemas.ts';
import { jwksCache } from '../db/schema.ts';
import { GrantError } from '../errors.ts';
import { parseStrictJson } from '@conservationtv/versioned-api/server';
import { services } from '../services.ts';

const MAX_DOCUMENT_BYTES = 64 * 1024;
const MAX_KEYS = 16;
const FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_FRESH_SECONDS = 300;
const MIN_FRESH_SECONDS = 60;
const MAX_FRESH_SECONDS = 3_600;
/** How long a cached set stays usable after it should have been refreshed, covering short consumer JWKS outages. */
const STALE_USE_SECONDS = 3_600;
/** Optional refreshes (stale sets, unknown `kid`s) are attempted at most this often per JWKS URI. */
const REFRESH_INTERVAL_MS = 30_000;

/** A published verification key, reduced to the members the verifier uses. */
const PublishedJwkSchema = z
  .object({
    kty: z.enum(['EC', 'RSA', 'OKP']),
    kid: z.string().min(1).max(256),
    use: z.literal('sig').optional(),
    alg: z.string().optional(),
    crv: z.string().optional(),
    x: z.string().optional(),
    y: z.string().optional(),
    n: z.string().optional(),
    e: z.string().optional()
  })
  .transform(({ kty, kid, alg, crv, x, y, n, e }) => ({ kty, kid, alg, crv, x, y, n, e }));
export type PublishedJwk = z.output<typeof PublishedJwkSchema>;

/** A document containing private or symmetric key material is a misconfiguration; refuse it outright. */
const PublishedJwkSetSchema = z.object({
  keys: z
    .array(
      z.looseObject({
        d: z.never().optional(),
        p: z.never().optional(),
        q: z.never().optional(),
        k: z.never().optional()
      })
    )
    .max(MAX_KEYS)
});
export type PublishedJwkSet = z.output<typeof PublishedJwkSetSchema>;

const StoredKeysSchema = z.array(PublishedJwkSchema);
type StoredKeys = z.output<typeof StoredKeysSchema>;

interface KeySet {
  keys: StoredKeys;
  fetchedAt: number;
  freshUntil: number;
  staleUntil: number;
}

/** Keys that are not for signature verification (or of unsupported types) are skipped, not fatal. */
function verificationKeys(document: PublishedJwkSet): StoredKeys {
  return document.keys.flatMap(key => {
    const parsed = PublishedJwkSchema.safeParse(key);
    return parsed.success ? [parsed.data] : [];
  });
}

function freshSeconds(cacheControl: string | null): number {
  const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl ?? '')?.[1];
  const requested = maxAge === undefined ? DEFAULT_FRESH_SECONDS : Number(maxAge);
  return Math.min(Math.max(requested, MIN_FRESH_SECONDS), MAX_FRESH_SECONDS);
}

/**
 * Read at most MAX_DOCUMENT_BYTES, refusing a declared or actual body over the limit without buffering the excess, then
 * decode it as strict UTF-8.
 */
async function readLimited(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_DOCUMENT_BYTES || !response.body) {
    await response.body?.cancel();
    throw new Error('JWKS response is too large or empty');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    size += chunk.value.byteLength;
    if (size > MAX_DOCUMENT_BYTES) {
      await reader.cancel();
      throw new Error('JWKS response is too large');
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
}

/** Only the registered URI is fetched. Redirects are refused rather than followed to a host nobody registered. */
async function download(uri: JwksUri): Promise<KeySet> {
  const { fetch, clock } = services();
  const response = await fetch(uri, {
    redirect: 'manual',
    headers: { accept: 'application/jwk-set+json, application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`JWKS responded with HTTP ${response.status}`);
  }
  const document = PublishedJwkSetSchema.parse(parseStrictJson(await readLimited(response)));
  const fetchedAt = clock();
  const freshUntil = fetchedAt + freshSeconds(response.headers.get('cache-control')) * 1000;
  return { keys: verificationKeys(document), fetchedAt, freshUntil, staleUntil: freshUntil + STALE_USE_SECONDS * 1000 };
}

/**
 * Consumer key sets, cached in isolate memory and persisted so other isolates (and restarts) start warm. Normal
 * validation never waits on the network: a fresh set is used as is, a stale one is refreshed opportunistically and
 * still used if the refresh fails, and only a missing or expired set makes the exchange depend on the consumer's JWKS.
 */
export class JwksCache {
  private readonly entries = new Map<string, KeySet>();
  private readonly pending = new Map<string, Promise<KeySet>>();
  private readonly attempted = new Map<string, number>();

  async key(uri: JwksUri, kid: string): Promise<PublishedJwk> {
    const now = services().clock();
    let entry = this.entries.get(uri) ?? (await this.restore(uri));
    // Fail closed once the stale-use period has elapsed; otherwise prefer cached keys over a live request.
    if (!entry || now >= entry.staleUntil) entry = await this.required(uri);
    else if (now >= entry.freshUntil) entry = await this.optional(uri, entry, now);
    let key = entry.keys.find(candidate => candidate.kid === kid);
    // An unknown kid may be a newly rotated key: allow one rate-limited refresh before rejecting it.
    if (!key && now - entry.fetchedAt >= REFRESH_INTERVAL_MS) {
      entry = await this.optional(uri, entry, now);
      key = entry.keys.find(candidate => candidate.kid === kid);
    }
    if (!key) throw new GrantError('unknown_key');
    return key;
  }

  private async required(uri: JwksUri): Promise<KeySet> {
    try {
      return await this.refresh(uri);
    } catch (error) {
      throw new GrantError('relay_unavailable', { cause: error });
    }
  }

  private async optional(uri: JwksUri, current: KeySet, now: number): Promise<KeySet> {
    if (now - (this.attempted.get(uri) ?? 0) < REFRESH_INTERVAL_MS) return current;
    return this.refresh(uri).catch(error => {
      console.warn(JSON.stringify({ event: 'jwks_refresh_failed', uri, error: String(error) }));
      return current;
    });
  }

  /** Concurrent refreshes of one URI share a single request. */
  private refresh(uri: JwksUri): Promise<KeySet> {
    let request = this.pending.get(uri);
    if (!request) {
      this.attempted.set(uri, services().clock());
      request = download(uri)
        .then(async entry => {
          this.entries.set(uri, entry);
          await this.persist(uri, entry);
          return entry;
        })
        .finally(() => this.pending.delete(uri));
      this.pending.set(uri, request);
    }
    return request;
  }

  private async restore(uri: JwksUri): Promise<KeySet | undefined> {
    const db = await services().database();
    const [row] = await db.select().from(jwksCache).where(eq(jwksCache.jwksUri, uri)).limit(1);
    const keys = StoredKeysSchema.safeParse(row?.keys);
    if (!row || !keys.success) return undefined;
    const entry = {
      keys: keys.data,
      fetchedAt: row.fetchedAt.getTime(),
      freshUntil: row.freshUntil.getTime(),
      staleUntil: row.staleUntil.getTime()
    };
    this.entries.set(uri, entry);
    return entry;
  }

  /** Persistence is an optimisation; a failure here must not fail an exchange that already has valid keys. */
  private async persist(uri: JwksUri, entry: KeySet): Promise<void> {
    try {
      const db = await services().database();
      const values = {
        keys: entry.keys,
        fetchedAt: new Date(entry.fetchedAt),
        freshUntil: new Date(entry.freshUntil),
        staleUntil: new Date(entry.staleUntil)
      };
      await db
        .insert(jwksCache)
        .values({ jwksUri: uri, ...values })
        .onConflictDoUpdate({ target: jwksCache.jwksUri, set: values });
    } catch (error) {
      console.warn(JSON.stringify({ event: 'jwks_persist_failed', uri, error: String(error) }));
    }
  }
}
