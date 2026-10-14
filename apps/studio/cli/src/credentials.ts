import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

// Tokens from `studio login`, one per API URL, in the user's config directory. A plain file with owner-only
// permissions, like most CLIs' credentials; a keychain can replace it later without changing the commands.

const CredentialSchema = z.object({ token: z.string().min(1), email: z.string().optional() });
export type Credential = z.output<typeof CredentialSchema>;
const CredentialsFileSchema = z.record(z.url(), CredentialSchema);
type CredentialsFile = z.output<typeof CredentialsFileSchema>;

export function credentialsPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'studio', 'credentials.json');
}

function readAll(): CredentialsFile {
  try {
    return CredentialsFileSchema.parse(JSON.parse(readFileSync(credentialsPath(), 'utf8')));
  } catch {
    // Missing or unreadable means signed out everywhere; an invalid file is replaced on the next login.
    return {};
  }
}

function writeAll(file: CredentialsFile): void {
  const path = credentialsPath();
  if (Object.keys(file).length === 0) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function readCredential(apiUrl: string): Credential | undefined {
  return readAll()[apiUrl];
}

export function writeCredential(apiUrl: string, credential: Credential): void {
  writeAll({ ...readAll(), [apiUrl]: credential });
}

export function clearCredential(apiUrl: string): void {
  const { [apiUrl]: _, ...rest } = readAll();
  writeAll(rest);
}
