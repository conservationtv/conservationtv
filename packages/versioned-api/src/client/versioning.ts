import * as z from 'zod';
import {
  ClientTransport,
  type Operation,
  type OperationCall,
  type OperationDescriptor,
  type OperationOutcome,
  type RawResult
} from './transport.js';
import { asError } from './errors.js';

// The runtime behind the generated Client. A versioned operation exposes every version this client was
// generated with (`v1`, `v2`, ...) and the version negotiated with the server (`version`). The server can serve multiple versions
// of each; `handshake` reads which from the operation manifest it publishes. A versionless operation, one the spec gives
// no version, is the plain call: no handshake, no header, and no compatibility guarantees.

export const OPERATION_VERSION_HEADER = 'Operation-Version';

/** Where the API publishes its operation manifest: every version it serves of each versioned operation. */
export const OPERATION_MANIFEST_URL = '/operations.json';

/** Where the API publishes the OpenAPI document it was generated with; servers older than the manifest publish only this. */
export const PUBLISHED_DOCUMENT_URL = '/openapi.json';

const VersionSchema = z.number().int().positive();
type Version = z.output<typeof VersionSchema>;

/** The operation manifest: each versioned operation's served versions, keyed by operationId. */
export const OperationManifestSchema = z.object({
  operations: z.record(z.string(), z.array(VersionSchema).nonempty())
});
export type OperationManifest = z.output<typeof OperationManifestSchema>;

// LEGACY: the parts of the published document a server older than the manifest is read for. An operation without
// `x-operation-version` is versionless. Remove with the fallback in `fetchManifest` once every server publishes one.
const PublishedOperationSchema = z.object({
  operationId: z.string(),
  'x-operation-version': VersionSchema.optional(),
  'x-operation-versions': z.array(VersionSchema).nonempty().optional()
});
type PublishedOperation = z.output<typeof PublishedOperationSchema>;
const PublishedPathItemSchema = z.object({
  get: PublishedOperationSchema.optional(),
  put: PublishedOperationSchema.optional(),
  post: PublishedOperationSchema.optional(),
  delete: PublishedOperationSchema.optional(),
  patch: PublishedOperationSchema.optional(),
  options: PublishedOperationSchema.optional(),
  head: PublishedOperationSchema.optional(),
  trace: PublishedOperationSchema.optional()
});
type PublishedPathItem = z.output<typeof PublishedPathItemSchema>;
const PublishedDocumentSchema = z.object({ paths: z.record(z.string(), PublishedPathItemSchema) });
type PublishedDocument = z.output<typeof PublishedDocumentSchema>;

export type { ClientConfig, HttpRuntime } from './transport.js';

type VersionKey = `v${number}`;

/** An operation's versions, each described from the contract that defines it. */
export type OperationVersions = Partial<Record<VersionKey, Operation>>;

type VersionNumber<Key> = Key extends `v${infer N extends number}` ? N : never;
type VersionKeys<Versions> = keyof Versions & VersionKey;

export interface VersionTag<Version extends number> {
  readonly version: Version;
}

/** One version of an operation: its call, tagged with its version. */
export type VersionedCall<Method, Version extends number> = Method & VersionTag<Version>;

type CallFor<Versions, Key> =
  Key extends VersionKeys<Versions> ? VersionedCall<OperationCall<Versions[Key]>, VersionNumber<Key>> : never;

export interface OperationState<Id extends string, Versions> {
  readonly operationId: Id;
  /**
   * The version negotiated with the server, or `undefined` if it serves none of the versions this client has. Throws
   * before `handshake`.
   */
  readonly version: VersionNumber<VersionKeys<Versions>> | undefined;
}

export type VersionedOperation<Id extends string, Versions extends OperationVersions> = OperationState<Id, Versions> & {
  readonly [Key in VersionKeys<Versions>]: CallFor<Versions, Key>;
};

/** An operation's version getter throws this before a handshake succeeds; a call handshakes itself instead. */
export class HandshakeRequiredError extends Error {
  readonly operationId: string;

  constructor(operationId: string) {
    super(`Call handshake() before using ${operationId}`);
    this.operationId = operationId;
  }
}

/** Fetching the server's operation manifest failed, or it isn't one. */
export class HandshakeError extends Error {}

/** The client called a version of an operation that the server doesn't serve. */
export class OperationVersionUnavailableError extends Error {
  readonly operationId: string;
  readonly requested: number;
  readonly negotiated: number | undefined;

  constructor(operationId: string, requested: number, negotiated: number | undefined) {
    super(
      negotiated === undefined
        ? `The server serves no version of ${operationId} that this client supports`
        : `The server does not serve ${operationId} at version ${requested}; highest shared version is ${negotiated}`
    );
    this.operationId = operationId;
    this.requested = requested;
    this.negotiated = negotiated;
  }
}

/**
 * The server changed an operation's version between the handshake and a call, for example during a deploy. The call
 * wasn't retried, because its arguments were built for the old version; check the operation's `version` again.
 */
export class OperationVersionChangedError extends Error {
  readonly operationId: string;
  readonly previous: number;
  readonly current: number | undefined;

  constructor(operationId: string, previous: number, current: number | undefined) {
    super(`${operationId} changed from version ${previous} to ${current ?? 'unsupported'} on the server`);
    this.operationId = operationId;
    this.previous = previous;
    this.current = current;
  }
}

export abstract class ClientCore extends ClientTransport {
  /** The versions this client has of each operation, filled by `versioned` as the generated class initialises. */
  private readonly supported = new Map<string, number[]>();
  private negotiated: Map<string, number> | undefined;
  private available = new Map<string, number[]>();
  /** Where the last negotiation read from, and its entity tag, sent back so an unchanged source costs a 304. */
  private validator: Validator | undefined;
  private pendingHandshake: Promise<void> | undefined;

  /**
   * Reads all versions of each versioned operation the server serves from its operation manifest. Call before
   * any versioned operation, and again to refresh. Rejects with HandshakeError on failure. A versioned call made before
   * one has succeeded handshakes itself, joining one in flight, so callers can start it without awaiting it.
   * Versionless operations don't need it.
   */
  handshake(): Promise<void> {
    // Concurrent calls that hit a version mismatch share one handshake.
    if (this.pendingHandshake == null) {
      this.pendingHandshake = this.readManifest()
        .catch(error => {
          throw error instanceof HandshakeError ? error : new HandshakeError('Handshake failed', { cause: error });
        })
        .finally(() => {
          this.pendingHandshake = undefined;
        });
    }
    return this.pendingHandshake;
  }

  /** Registers a versioned operation's versions. The generated Client calls this once per operation. */
  protected versioned<const Id extends string, const Versions extends OperationVersions>(
    operationId: Id,
    versions: Versions
  ): VersionedOperation<Id, Versions> {
    const calls = new Map<string, VersionTag<number>>();
    for (const [key, described] of Object.entries(versions)) {
      if (described) calls.set(key, this.versionedCall(operationId, Number(key.slice(1)), described));
    }
    this.supported.set(
      operationId,
      [...calls.values()].map(call => call.version)
    );
    const versionOf = () => this.versionOf(operationId);
    const state = {
      operationId,
      get version() {
        return versionOf();
      }
    };
    // SAFETY: `state` implements OperationState for these versions, and `calls` holds a tagged call for each key of
    // `versions`, which is what the mapped type adds.
    return Object.assign(state, Object.fromEntries(calls)) as VersionedOperation<Id, Versions>;
  }

  /** Unversioned operations use the same success-body-or-Error result as versioned calls. */
  protected versionless<Described extends Operation>(described: Described): OperationCall<Described> {
    return this.call(described);
  }

  /**
   * Fetch and validate the manifest, then negotiate every operation against it at once. Once negotiated, it is asked
   * for conditionally: a 304 says it is unchanged, so what was negotiated stands. Browsers do this in their HTTP cache;
   * runtimes without one, such as Node, would otherwise download and parse it every time.
   */
  private async readManifest(): Promise<void> {
    const fetched = await this.fetchManifest();
    if (fetched === 'unchanged') return;
    const { negotiated, available } = negotiate(fetched.manifest, this.supported);
    this.negotiated = negotiated;
    this.available = available;
    const etag = fetched.response?.headers.get('ETag');
    this.validator = etag ? { url: fetched.url, etag } : undefined;
  }

  /** The manifest, or for a server that predates it, the one its published document describes. */
  private async fetchManifest(): Promise<Fetched | 'unchanged'> {
    const result = await this.fetchConditionally(OPERATION_MANIFEST_URL);
    if (result === 'unchanged') return result;
    // LEGACY: a server older than the manifest answers 404 for it. Remove once every server publishes one.
    if (result.response?.status === 404) {
      const legacy = await this.fetchConditionally(PUBLISHED_DOCUMENT_URL);
      if (legacy === 'unchanged') return legacy;
      const document = parse(PUBLISHED_DOCUMENT_URL, legacy, PublishedDocumentSchema);
      const manifest = manifestFromDocument(document);
      return { url: PUBLISHED_DOCUMENT_URL, manifest, response: legacy.response };
    }
    const manifest = parse(OPERATION_MANIFEST_URL, result, OperationManifestSchema);
    return { url: OPERATION_MANIFEST_URL, manifest, response: result.response };
  }

  /** GET `url`, conditionally if it is what was last negotiated against: `'unchanged'` when the server answers 304. */
  private async fetchConditionally(url: string): Promise<RawResult | 'unchanged'> {
    const validator = this.negotiated !== undefined && this.validator?.url === url ? this.validator : undefined;
    const headers = validator ? { 'If-None-Match': validator.etag } : undefined;
    const result = await this.transport.get({ url, headers });
    return validator && result.response?.status === 304 ? 'unchanged' : result;
  }

  private versionOf(operationId: string): number | undefined {
    if (!this.negotiated) throw new HandshakeRequiredError(operationId);
    return this.negotiated.get(operationId);
  }

  private versionedCall(operationId: string, version: number, described: OperationDescriptor): VersionTag<number> {
    const call = async (...args: unknown[]) => {
      try {
        return await this.invoke(operationId, version, described, args);
      } catch (error) {
        return asError(error);
      }
    };
    return Object.assign(call, { version });
  }

  /** Refresh after a protocol rejection; retry only the same requested version, once. */
  private async invoke(
    operationId: string,
    version: number,
    described: OperationDescriptor,
    args: unknown[]
  ): Promise<OperationOutcome> {
    // Until one succeeds, every call handshakes, joining one in flight; its HandshakeError becomes this call's result.
    if (!this.negotiated) await this.handshake();
    const negotiated = this.versionOf(operationId);
    if (!this.available.get(operationId)?.includes(version))
      return new OperationVersionUnavailableError(operationId, version, negotiated);

    const first = await this.send(described, args, version);
    if (!first.mismatched) return first.result;
    await this.handshake();
    const current = this.versionOf(operationId);
    if (!this.available.get(operationId)?.includes(version))
      return new OperationVersionChangedError(operationId, version, current);
    return (await this.send(described, args, version)).result;
  }
}

/** Where a negotiation read from, and the entity tag it was served with. */
interface Validator {
  url: string;
  etag: string;
}

/** A manifest as fetched, with where it came from and the response that carried it. */
interface Fetched {
  url: string;
  manifest: OperationManifest;
  response: Response | undefined;
}

/** A successful response's body, validated, or HandshakeError naming the request that failed. */
function parse<Output>(url: string, result: RawResult, schema: z.ZodType<Output>): Output {
  const parsed = schema.safeParse(result.data);
  if (parsed.success) return parsed.data;
  const status = result.response?.status ?? 'no response';
  throw new HandshakeError(`GET ${url} failed (${status})`, { cause: result.error ?? parsed.error });
}

/** LEGACY: the manifest a published document describes, checked as the old handshake checked the document. */
function manifestFromDocument(document: PublishedDocument): OperationManifest {
  const operations = Object.values(document.paths).flatMap((item: PublishedPathItem) => Object.values(item));
  const manifest: Record<string, Version[]> = {};
  const seen = new Set<string>();
  // Every operationId once, versionless ones included; only versioned ones enter the manifest.
  for (const operation of operations) {
    if (!operation) continue;
    if (seen.has(operation.operationId)) throw new HandshakeError(`Duplicate operationId: ${operation.operationId}`);
    seen.add(operation.operationId);
    const served = servedVersions(operation);
    if (served) manifest[operation.operationId] = served;
  }
  return { operations: manifest };
}

/** LEGACY: an operation's advertised set; an older document advertises only its described version. */
function servedVersions(operation: PublishedOperation): Version[] | undefined {
  const described = operation['x-operation-version'];
  const served = operation['x-operation-versions'] ?? (described === undefined ? undefined : [described]);
  if (served && (described === undefined || !served.includes(described))) {
    throw new HandshakeError(`Invalid served versions for ${operation.operationId}`);
  }
  return served;
}

/** Negotiate each operation independently, retaining all shared versions for explicit vN calls. */
function negotiate(manifest: OperationManifest, supported: Map<string, number[]>) {
  const negotiated = new Map<string, number>();
  const available = new Map<string, number[]>();
  for (const [operationId, served] of Object.entries(manifest.operations)) {
    if (new Set(served).size !== served.length) throw new HandshakeError(`Invalid served versions for ${operationId}`);
    // Preserve every shared version, and choose the highest as the default.
    const ours = supported.get(operationId);
    const shared = served.filter(version => ours?.includes(version)).sort((a, b) => a - b);
    available.set(operationId, shared);
    if (shared.length) negotiated.set(operationId, shared.at(-1)!);
  }
  return { negotiated, available };
}
