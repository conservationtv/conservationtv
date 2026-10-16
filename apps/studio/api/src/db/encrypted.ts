import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { customType } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { useServices } from '../services.ts';

// Fields encrypted at rest, application-side, so the database and its backups only ever hold ciphertext. Each column
// seals under a subkey of the field key derived for its purpose. Equality lookups go through a blind index: a keyed
// hash stored beside the column, under its own subkey.
//
// There is one field key and no rotation yet, since nothing re-seals existing rows. Every sealed value starts with a
// key version byte, always 1 for now, so that rotation can be added without rewriting what is already stored.

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;
const KEY_VERSION = 1;

/**
 * A subkey per purpose, so a ciphertext or index from one column is useless in another: HKDF-SHA256 with the label as
 * its info. The field key is already uniformly random, so the salt is empty.
 */
const derive = (label: string) => {
  const services = useServices();
  return Buffer.from(hkdfSync('sha256', services.config.FIELD_KEY, new Uint8Array(), label, 32));
};

/** `version ‖ iv ‖ tag ‖ ciphertext`. */
const seal = (purpose: string, plaintext: Uint8Array) => {
  const key = derive(`encrypt:${purpose}`);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.of(KEY_VERSION), iv, cipher.getAuthTag(), body]);
};

const open = (purpose: string, sealed: Uint8Array) => {
  const bytes = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  if (bytes[0] !== KEY_VERSION) throw new Error(`Unknown field key version: ${bytes[0]}`);
  const key = derive(`encrypt:${purpose}`);
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
  return createHmac('sha256', derive(`index:${purpose}`))
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
