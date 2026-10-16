import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { apiUrl } from './api.js';
import { LoginError } from './errors.js';

// Logins from `ctv login`, one per API URL, in the user's config directory. A login is one session token and a profile
// per organisation the session joined: the browser device it registered there, whose private key is the CLI's iroh
// identity in that organisation. One profile is current; commands act as it. A plain file with owner-only
// permissions, like most CLIs' credentials; a keychain can replace it later without changing the commands.

const DeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  publicKey: z.string(),
  publicId: z.string(),
  /** The raw 32-byte Ed25519 seed, unpadded base64url, as the studio API returns it. */
  privateKey: z.string().refine(key => Buffer.from(key, 'base64url').length === 32, 'A private key is 32 bytes')
});
export type Device = z.output<typeof DeviceSchema>;

const ProfileSchema = z.object({
  organisationId: z.string(),
  organisationName: z.string(),
  device: DeviceSchema
});
export type Profile = z.output<typeof ProfileSchema>;

const CredentialSchema = z
  .object({
    token: z.string().min(1),
    email: z.string().optional(),
    /** By organisation id. */
    profiles: z.record(z.string(), ProfileSchema),
    /** The organisation id of the current profile. */
    current: z.string()
  })
  .refine(credential => credential.current in credential.profiles, 'The current profile must exist');
export type Credential = z.output<typeof CredentialSchema>;

const CredentialsFileSchema = z.record(z.url(), CredentialSchema);
type CredentialsFile = z.output<typeof CredentialsFileSchema>;

export function credentialsPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'ctv', 'credentials.json');
}

function readCredentials(): CredentialsFile {
  try {
    return CredentialsFileSchema.parse(JSON.parse(readFileSync(credentialsPath(), 'utf8')));
  } catch {
    // Missing or unreadable means signed out everywhere; an invalid file is replaced on the next login.
    return {};
  }
}

function writeCredentials(file: CredentialsFile): void {
  const path = credentialsPath();
  if (Object.keys(file).length === 0) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** The login stored for the API, if any. */
export function readCredential(): Credential | undefined {
  const file = readCredentials();
  return file[apiUrl];
}

/** The stored login; being signed out is a failure the person can fix. */
export function requireCredential(): Credential {
  const credential = readCredential();
  if (credential === undefined) throw new LoginError('Not logged in: run `ctv login` first.');
  return credential;
}

export function saveCredential(credential: Credential): void {
  const file = readCredentials();
  writeCredentials({ ...file, [apiUrl]: credential });
}

export function forgetCredential(): void {
  const { [apiUrl]: _, ...rest } = readCredentials();
  writeCredentials(rest);
}

/** The bearer token studio commands send: `STUDIO_TOKEN` for scripts and CI, else the stored login's. */
export function currentToken(): string | undefined {
  if (process.env.STUDIO_TOKEN) return process.env.STUDIO_TOKEN;
  const credential = readCredential();
  return credential?.token;
}

/** The profile commands act as. */
export function currentProfile(credential: Credential): Profile {
  return credential.profiles[credential.current]!;
}

/** The device's private key as the secret key bytes iroh takes. */
export function secretKeyOf(device: Device): Uint8Array {
  return new Uint8Array(Buffer.from(device.privateKey, 'base64url'));
}
