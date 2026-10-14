import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { clearCredential, readCredential, writeCredential, type Credential } from './credentials.js';

/** The client ID the API's device flow accepts for this CLI. */
export const CLIENT_ID = 'studio-cli';

const DeviceCodeSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string().optional(),
  expires_in: z.number(),
  interval: z.number().default(5)
});
type DeviceCode = z.output<typeof DeviceCodeSchema>;
const TokenSchema = z.object({ access_token: z.string() });
type Token = z.output<typeof TokenSchema>;
const PendingSchema = z.object({
  error: z.enum([
    'authorization_pending',
    'slow_down',
    'expired_token',
    'access_denied',
    'invalid_grant',
    'invalid_request'
  ]),
  error_description: z.string().optional()
});
type Pending = z.output<typeof PendingSchema>;
const SessionSchema = z.object({ user: z.object({ email: z.string() }) }).nullable();
type Session = z.output<typeof SessionSchema>;

export class LoginError extends Error {}

type JsonBody = Record<string, string>;

async function postJson(url: string, body: JsonBody, token?: string): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (token) headers.set('authorization', `Bearer ${token}`);
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function requestDeviceCode(apiUrl: string): Promise<DeviceCode> {
  const response = await postJson(`${apiUrl}/auth/device/code`, { client_id: CLIENT_ID });
  if (!response.ok) throw new LoginError(`The API refused to start a device login (HTTP ${response.status}).`);
  return DeviceCodeSchema.parse(await response.json());
}

/** Poll until the person approves or denies the code in the web app, backing off when asked to. */
async function waitForApproval(apiUrl: string, code: DeviceCode): Promise<Token> {
  const deadline = Date.now() + code.expires_in * 1000;
  let interval = code.interval;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const response = await postJson(`${apiUrl}/auth/device/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: code.device_code,
      client_id: CLIENT_ID
    });
    const body: unknown = await response.json();
    if (response.ok) return TokenSchema.parse(body);
    const pending: Pending = PendingSchema.parse(body);
    // Only the two waiting states continue; every other error ends the login.
    switch (pending.error) {
      case 'authorization_pending':
        break;
      case 'slow_down':
        interval += 5;
        break;
      default:
        throw new LoginError(pending.error_description ?? `Login failed: ${pending.error}`);
    }
  }
  throw new LoginError('The code expired before it was approved. Run `studio login` again.');
}

async function whoAmI(apiUrl: string, token: string): Promise<Session> {
  const response = await fetch(`${apiUrl}/auth/get-session`, { headers: { authorization: `Bearer ${token}` } });
  return response.ok ? SessionSchema.parse(await response.json()) : null;
}

export interface LoginResult {
  api: string;
  email: string | undefined;
}

/** The OAuth device flow: show a code, wait for approval in the browser, store the resulting token. */
export async function login(apiUrl: string, announce: (message: string) => void): Promise<LoginResult> {
  const code = await requestDeviceCode(apiUrl);
  announce(`Open ${code.verification_uri_complete ?? code.verification_uri} and approve the code ${code.user_code}.`);
  const token = await waitForApproval(apiUrl, code);
  const session = await whoAmI(apiUrl, token.access_token);
  const credential: Credential = { token: token.access_token, email: session?.user.email };
  writeCredential(apiUrl, credential);
  return { api: apiUrl, email: credential.email };
}

/** Revoke the stored session on the API, then forget it locally either way. */
export async function logout(apiUrl: string): Promise<boolean> {
  const credential = readCredential(apiUrl);
  if (!credential) return false;
  try {
    await postJson(`${apiUrl}/auth/sign-out`, {}, credential.token);
  } finally {
    clearCredential(apiUrl);
  }
  return true;
}

/** The bearer token for requests: `STUDIO_TOKEN` for non-interactive use, else the stored login. */
export function currentToken(apiUrl: string): string | undefined {
  return process.env.STUDIO_TOKEN || readCredential(apiUrl)?.token;
}
