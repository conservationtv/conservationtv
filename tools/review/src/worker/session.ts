import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';

// Who is signed in, kept in the browser rather than on the Worker: a cookie sealed with AES-GCM under SESSION_SECRET,
// so the GitHub token in it can be neither read nor forged, and only this Worker can use it.

export interface AppEnv {
  Bindings: Env;
}

export const SignedInSchema = z.object({ token: z.string(), login: z.string(), avatarUrl: z.url() });
export type SignedIn = z.output<typeof SignedInSchema>;

/** The OAuth round trip: what GitHub must send back, and where to return the reviewer to. */
export const AttemptSchema = z.object({ state: z.string(), to: z.string() });
export type Attempt = z.output<typeof AttemptSchema>;

/** What each cookie holds: each is sealed for its purpose, so one cannot be passed off as the other. */
interface Sealed {
  session: SignedIn;
  attempt: Attempt;
}
type Purpose = keyof Sealed;
const cookieNames = { session: 'review-session', attempt: 'review-attempt' } satisfies Record<Purpose, string>;
const lifetimes = { session: 30 * 24 * 60 * 60, attempt: 10 * 60 } satisfies Record<Purpose, number>;

const encoder = new TextEncoder();

async function keyOf(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

/** Twelve random bytes of nonce, then the ciphertext, with the purpose as associated data. */
async function seal<P extends Purpose>(secret: string, purpose: P, value: Sealed[P]): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyOf(secret);
  const plain = encoder.encode(JSON.stringify(value));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(purpose) },
    key,
    plain
  );
  return toBase64Url(new Uint8Array([...iv, ...new Uint8Array(cipher)]));
}

/** What a sealed cookie holds, or null when it is missing, tampered with, sealed for something else, or malformed. */
async function unseal<T extends z.ZodType>(
  secret: string,
  purpose: Purpose,
  sealed: string | undefined,
  schema: T
): Promise<z.output<T> | null> {
  if (!sealed) return null;
  try {
    const bytes = fromBase64Url(sealed);
    const key = await keyOf(secret);
    const algorithm = { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: encoder.encode(purpose) };
    const plain = await crypto.subtle.decrypt(algorithm, key, bytes.slice(12));
    return schema.safeParse(JSON.parse(new TextDecoder().decode(plain))).data ?? null;
  } catch {
    return null;
  }
}

/** Signing in needs an OAuth app's ID and secret, and a secret to seal sessions with. */
export function signInEnabled(env: Env): boolean {
  return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.SESSION_SECRET);
}

export async function writeCookie<P extends Purpose>(c: Context<AppEnv>, purpose: P, value: Sealed[P]): Promise<void> {
  const sealed = await seal(c.env.SESSION_SECRET, purpose, value);
  setCookie(c, cookieNames[purpose], sealed, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: lifetimes[purpose],
    prefix: 'host'
  });
}

export function clearCookie(c: Context<AppEnv>, purpose: Purpose): void {
  deleteCookie(c, cookieNames[purpose], { path: '/', secure: true, prefix: 'host' });
}

function readCookie<T extends z.ZodType>(c: Context<AppEnv>, purpose: Purpose, schema: T): Promise<z.output<T> | null> {
  if (!signInEnabled(c.env)) return Promise.resolve(null);
  return unseal(c.env.SESSION_SECRET, purpose, getCookie(c, cookieNames[purpose], 'host'), schema);
}

/** Who is signed in, if anyone. */
export function readSession(c: Context<AppEnv>): Promise<SignedIn | null> {
  return readCookie(c, 'session', SignedInSchema);
}

/** The sign-in this browser started, if any. */
export function readAttempt(c: Context<AppEnv>): Promise<Attempt | null> {
  return readCookie(c, 'attempt', AttemptSchema);
}
