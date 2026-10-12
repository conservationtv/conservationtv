import { createHash } from 'node:crypto';

/** Convert a human/resource name to a conservative DNS/cloud resource label. */
export function sanitizeName(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized;
}

/** Keep a name within a provider limit while retaining a stable identity suffix. */
export function truncateWithHash(value: string, maxLen: number): string {
  if (!Number.isInteger(maxLen) || maxLen < 1) {
    throw new Error('maxLen must be a positive integer.');
  }
  const name = sanitizeName(value);
  if (name.length <= maxLen) return name;

  const hash = createHash('sha256').update(name).digest('hex').slice(0, 8);
  if (maxLen <= hash.length + 1) return hash.slice(0, maxLen);
  return `${name.slice(0, maxLen - hash.length - 1).replace(/-+$/, '')}-${hash}`;
}

export function resourceName(...parts: string[]): string {
  return sanitizeName(parts.filter(part => part.trim() !== '').join('-'));
}
