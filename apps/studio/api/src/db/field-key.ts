import { createStore } from '@conservationtv/store';
import type { Config } from '../config.ts';

/** The master key for encrypted columns and blind indexes: 32 random bytes, from `FIELD_KEY`. */
export type FieldKey = Uint8Array;

export const [withFieldKey, useFieldKey] = createStore<FieldKey>('fieldKey');

const KEY_BYTES = 32;

/** The deployment's field key, decoded from standard base64. */
export function fieldKeyFrom(config: Config): FieldKey {
  const key = new Uint8Array(Buffer.from(config.FIELD_KEY, 'base64'));
  if (key.length !== KEY_BYTES) throw new Error(`FIELD_KEY must be ${KEY_BYTES} bytes of base64`);
  return key;
}
