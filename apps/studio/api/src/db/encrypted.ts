import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { customType } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { useKeyring, type Keyring } from './keyring.ts';

// Fields encrypted at rest, application-side, so the database and its backups only ever hold ciphertext. Each column
// seals under a subkey of the current master key derived for its purpose, and records the master key's version so
// rotation never needs a rewrite. Equality lookups go through a blind index: a keyed hash stored beside the column.

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

/** A subkey per purpose, so a ciphertext or index from one column is useless in another. */
const derive = (master: Uint8Array, label: string) => createHmac('sha256', master).update(label).digest();

const masterKey = (keyring: Keyring, version: number) => {
  const key = keyring.keys.get(version);
  if (key === undefined) throw new Error(`Unknown field key version: ${version}`);
  return key;
};

/** `version ‖ iv ‖ tag ‖ ciphertext`. */
const seal = (purpose: string, plaintext: Uint8Array) => {
  const keyring = useKeyring();
  const key = derive(masterKey(keyring, keyring.current), `encrypt:${purpose}`);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.of(keyring.current), iv, cipher.getAuthTag(), body]);
};

const open = (purpose: string, sealed: Uint8Array) => {
  const keyring = useKeyring();
  const bytes = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  const key = derive(masterKey(keyring, bytes[0]!), `encrypt:${purpose}`);
  const decipher = createDecipheriv(ALGORITHM, key, bytes.subarray(1, 1 + IV_BYTES));
  decipher.setAuthTag(bytes.subarray(1 + IV_BYTES, HEADER_BYTES));
  return new Uint8Array(Buffer.concat([decipher.update(bytes.subarray(HEADER_BYTES)), decipher.final()]));
};

/** Any codec from plaintext bytes to a value; the column's type is the codec's output. */
export type FieldCodec<T> = z.ZodType<T, Uint8Array>;

/** An encrypted column's values: `T` in the application, sealed bytes in the driver. */
interface EncryptedColumn<T> {
  data: T;
  driverData: Uint8Array;
}

/**
 * An AES-256-GCM column. `purpose` names the key it is sealed under and must never change, so renaming the column
 * or table keeps existing rows readable.
 */
export const encrypted = <T>(purpose: string, codec: FieldCodec<T>) =>
  customType<EncryptedColumn<T>>({
    dataType: () => 'bytea',
    codec: 'bytea',
    toDriver: value => seal(purpose, z.encode(codec, value)),
    fromDriver: sealed => z.decode(codec, open(purpose, sealed))
  });

/** A keyed hash of a value for equality lookups, through the same codec its encrypted column uses. */
export const blindIndex = <T>(purpose: string, codec: FieldCodec<T>, value: T) => {
  const keyring = useKeyring();
  return createHmac('sha256', derive(keyring.index, `index:${purpose}`))
    .update(z.encode(codec, value))
    .digest();
};

export const BytesSchema = z.custom<Uint8Array>(value => value instanceof Uint8Array, 'Expected bytes');
export type Bytes = z.output<typeof BytesSchema>;

export const Utf8Schema = z.codec(BytesSchema, z.string(), {
  decode: value => new TextDecoder().decode(value),
  encode: value => new TextEncoder().encode(value)
});
export type Utf8 = z.output<typeof Utf8Schema>;

/** JSON text to a value of `schema`, which can itself contain codecs such as `IsoDatetimeSchema`. */
export const jsonText = <T extends z.ZodType>(schema: T) =>
  z.codec(z.string(), schema, {
    decode: (text, ctx) => {
      try {
        return JSON.parse(text);
      } catch {
        ctx.issues.push({ code: 'invalid_format', format: 'json', input: text });
        return z.NEVER;
      }
    },
    encode: value => JSON.stringify(value)
  });

export const json = <T extends z.ZodType>(schema: T) => Utf8Schema.pipe(jsonText(schema));

export const IsoDatetimeSchema = z.codec(z.iso.datetime(), z.date(), {
  decode: value => new Date(value),
  encode: value => value.toISOString()
});
export type IsoDatetime = z.output<typeof IsoDatetimeSchema>;
