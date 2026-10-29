import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DeviceIdentity } from '@conservationtv/studio-sdk';
import { z } from 'zod';
import { apiUrlOf, ENVIRONMENTS, type Environment } from './api.js';
import { LoginError } from './errors.js';
import { useScope } from './scope.js';

// Logins from `ctv login`, in the user's config directory. A login is a session: one account signed in to one
// environment's studio API. A profile is a session's browser device in one organisation, whose private key is the
// CLI's iroh identity there, and is named so it can be chosen. Profiles of different sessions live side by side; one
// is current, and commands act as it unless `--profile` names another. A plain file with owner-only permissions, like
// most CLIs' credentials; a keychain can replace it later without changing the commands.

const SessionSchema = z.object({
  env: z.enum(ENVIRONMENTS),
  /** A `local` login's own API, from `ctv login --url`, in place of `pnpm dev`'s. */
  url: z.url().optional(),
  token: z.string().min(1),
  email: z.string()
});
export type Session = z.output<typeof SessionSchema>;

/** The studio API a session signed in to. */
export function sessionApiUrl(session: Session): string {
  return session.url ?? apiUrlOf(session.env);
}

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
  /** The id of the session it belongs to. */
  session: z.string(),
  organisationId: z.string(),
  organisationName: z.string(),
  device: DeviceSchema
});
export type Profile = z.output<typeof ProfileSchema>;

const CredentialsSchema = z
  .object({
    /** By a random id, which only this file uses. */
    sessions: z.record(z.string(), SessionSchema),
    /** By name. */
    profiles: z.record(z.string(), ProfileSchema),
    /** The name of the current profile, if there is one. */
    current: z.string().optional()
  })
  .refine(
    credentials => Object.values(credentials.profiles).every(profile => profile.session in credentials.sessions),
    "Every profile's session must exist"
  )
  .refine(
    credentials => credentials.current === undefined || credentials.current in credentials.profiles,
    'The current profile must exist'
  );
export type Credentials = z.output<typeof CredentialsSchema>;

export function credentialsPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'ctv', 'credentials.json');
}

export function readCredentials(): Credentials {
  try {
    return CredentialsSchema.parse(JSON.parse(readFileSync(credentialsPath(), 'utf8')));
  } catch {
    // Missing or unreadable means signed out everywhere; an invalid file is replaced on the next login.
    return { sessions: {}, profiles: {} };
  }
}

export function writeCredentials(credentials: Credentials): void {
  const path = credentialsPath();
  if (Object.keys(credentials.sessions).length === 0) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** The session signed in to the API at `apiUrl` as `email`, by id, if there is one. */
export function findSession(credentials: Credentials, apiUrl: string, email: string) {
  const sessions = Object.entries(credentials.sessions);
  const found = sessions.find(([, session]) => sessionApiUrl(session) === apiUrl && session.email === email);
  return found?.[0];
}

/** The credentials without a session and its profiles. If the current profile was one of them, none is current. */
export function withoutSession(credentials: Credentials, sessionId: string): Credentials {
  const { [sessionId]: _, ...sessions } = credentials.sessions;
  const kept = Object.entries(credentials.profiles).filter(([, profile]) => profile.session !== sessionId);
  const profiles = Object.fromEntries(kept);
  const current =
    credentials.current !== undefined && credentials.current in profiles ? credentials.current : undefined;
  return { sessions, profiles, current };
}

/** A free profile name for an organisation in an environment, such as `staging/simulo-sanctuary`. */
export function profileName(credentials: Credentials, env: Environment, organisationName: string): string {
  const slug = organisationName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const base = `${env}/${slug || 'organisation'}`;
  let name = base;
  for (let suffix = 2; name in credentials.profiles; suffix++) name = `${base}-${suffix}`;
  return name;
}

/** The profile a command acts as, with its session and that session's studio API. */
export interface Active {
  name: string;
  profile: Profile;
  session: Session;
  apiUrl: string;
}

/** The profile `--profile` names, else the current one; none when signed out. */
export function activeProfile(credentials: Credentials): Active | undefined {
  const { globals } = useScope();
  const name = globals.profile ?? credentials.current;
  if (name === undefined) return undefined;
  const profile = credentials.profiles[name];
  if (profile === undefined) throw new LoginError(`There is no profile named "${name}": see \`ctv profiles list\`.`);
  const session = credentials.sessions[profile.session]!;
  const apiUrl = sessionApiUrl(session);
  return { name, profile, session, apiUrl };
}

/** `activeProfile`; being signed out is a failure the person can fix. */
export function requireProfile(credentials: Credentials): Active {
  const active = activeProfile(credentials);
  if (active !== undefined) return active;
  const signedIn = Object.keys(credentials.profiles).length > 0;
  const fix = signedIn ? 'choose one with `ctv profiles use`' : 'run `ctv login` first';
  throw new LoginError(`No current profile: ${fix}.`);
}

/** The device's identity, from its stored private key. */
export function identityOf(device: Device): Promise<DeviceIdentity> {
  const secretKey = new Uint8Array(Buffer.from(device.privateKey, 'base64url'));
  return DeviceIdentity.fromSecretKey(secretKey);
}
