/** The bytes an unpadded base64url string holds, as the studio API writes keys. */
export function bytesFromBase64url(text: string): Uint8Array {
  const base64 = text.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}

/** Bytes as lowercase hex, as agents read their secret key. */
export function hexFromBytes(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
