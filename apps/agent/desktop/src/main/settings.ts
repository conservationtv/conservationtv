import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getLogger } from '@logtape/logtape';
import { app, safeStorage } from 'electron';
import { z } from 'zod';
import type { AgentIdentity } from '../shared/bridge.ts';

// The agent this app runs as, in a file in the app's user data. Its secret key is encrypted by safeStorage: with a
// key the OS keychain keeps on macOS, DPAPI's on Windows, and the secret service's on Linux. Where none is available
// (Linux without a keyring), the key is kept as it is in a file only the user can read, as the CLI keeps its own.

const logger = getLogger(['desktop', 'settings']);

const SettingsSchema = z.object({
  id: z.string(),
  name: z.string(),
  apiUrl: z.url(),
  key: z.object({
    /** Whether `value` is safeStorage's encryption of the key, or the key as it is. */
    encrypted: z.boolean(),
    /** Base64. */
    value: z.string()
  })
});
type Settings = z.output<typeof SettingsSchema>;

/** The agent to run as, with its secret key. */
export interface AgentSettings extends AgentIdentity {
  secretKey: Uint8Array;
}

function settingsFile() {
  return join(app.getPath('userData'), 'agent.json');
}

/**
 * The agent's directory: where its runtimes keep what they install and run. One per agent, so an agent set up in place
 * of another never starts from the spec the other saved.
 */
export function agentDirectory(id: string) {
  return join(app.getPath('userData'), 'agents', id);
}

/** The agent this app was set up as, or `undefined` before it is. */
export async function readSettings(): Promise<AgentSettings | undefined> {
  // A missing or unreadable file is an app not yet set up.
  const text = await readFile(settingsFile(), 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  const parsed = SettingsSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    logger.warning('Ignoring settings that do not parse: {error}', { error: z.prettifyError(parsed.error) });
    return undefined;
  }
  const { key, ...identity }: Settings = parsed.data;
  const stored = Buffer.from(key.value, 'base64');
  const secretKey = key.encrypted ? Buffer.from(safeStorage.decryptString(stored), 'base64') : stored;
  return { ...identity, secretKey: new Uint8Array(secretKey) };
}

/** Keep `settings` as the agent to run as, replacing any before it. */
export async function writeSettings(settings: AgentSettings): Promise<void> {
  const { secretKey, ...identity } = settings;
  const plain = Buffer.from(secretKey).toString('base64');
  const encrypted = safeStorage.isEncryptionAvailable();
  if (!encrypted)
    logger.warning('No OS keychain to encrypt the agent key with: keeping it in a file only you can read');
  const value = encrypted ? safeStorage.encryptString(plain).toString('base64') : plain;
  const file: z.input<typeof SettingsSchema> = { ...identity, key: { encrypted, value } };
  await writeFile(settingsFile(), JSON.stringify(file, null, 2), { mode: 0o600 });
}

/** Forget the agent `id`, and everything it kept. */
export async function forgetSettings(id: string): Promise<void> {
  await rm(settingsFile(), { force: true });
  await rm(agentDirectory(id), { recursive: true, force: true });
}
