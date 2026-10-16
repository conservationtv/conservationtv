import { createStore } from '@conservationtv/store';
import type { Config } from '../config.ts';

/** Versioned master keys: `current` seals, every version opens; `index` keys blind indexes and never rotates. */
export interface Keyring {
  current: number;
  keys: ReadonlyMap<number, Uint8Array>;
  index: Uint8Array;
}

export const [withKeyring, useKeyring] = createStore<Keyring>('keyring');

const KEY_BYTES = 32;

/** A 32-byte key from standard base64. */
function keyFrom(name: string, base64: string) {
  const key = new Uint8Array(Buffer.from(base64, 'base64'));
  if (key.length !== KEY_BYTES) throw new Error(`${name} must be ${KEY_BYTES} bytes of base64`);
  return key;
}

/**
 * The deployment's keyring: `FIELD_KEYS` lists `<version>:<base64 key>` entries, and the highest version seals. Adding a
 * key rotates new writes onto it; older versions stay listed for as long as any row is sealed under them.
 */
export function keyringFrom(config: Config): Keyring {
  const keys = new Map<number, Uint8Array>();
  for (const entry of config.FIELD_KEYS) {
    const [version, base64] = entry.split(':');
    const number = Number(version);
    if (keys.has(number)) throw new Error(`FIELD_KEYS lists version ${number} twice`);
    keys.set(number, keyFrom(`FIELD_KEYS version ${number}`, base64!));
  }
  return { current: Math.max(...keys.keys()), keys, index: keyFrom('FIELD_INDEX_KEY', config.FIELD_INDEX_KEY) };
}
