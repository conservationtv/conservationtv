// Agents sign each report with an Ed25519 key registered for them. The signature covers the exact UTF-8 bytes of the
// report's JSON text, which travels as a string, so no canonical serialisation is needed: the bytes verified are the
// bytes parsed. Keys and signatures are unpadded base64url.

/** The only signing algorithm accepted so far. */
export const SIGNING_ALGORITHM = 'Ed25519';

/** Base64url (unpadded) to bytes; undefined when the text is not base64url. */
export function fromBase64Url(text: string) {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return undefined;
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

/** The verification key for a registered public key: 32 raw Ed25519 bytes, base64url. Undefined if it is not one. */
export async function verificationKey(publicKey: string) {
  const bytes = fromBase64Url(publicKey);
  if (bytes?.length !== 32) return undefined;
  try {
    return await crypto.subtle.importKey('raw', bytes, { name: SIGNING_ALGORITHM }, false, ['verify']);
  } catch {
    return undefined;
  }
}

/** Whether `signature` is the key's signature of the report text. */
export async function verifySignature(publicKey: string, report: string, signature: string) {
  const key = await verificationKey(publicKey);
  const bytes = fromBase64Url(signature);
  if (!key || bytes?.length !== 64) return false;
  return crypto.subtle.verify({ name: SIGNING_ALGORITHM }, key, bytes, new TextEncoder().encode(report));
}
