const digest = async (value: string) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));

/**
 * Whether a relay or the consumer presented its shared secret. Fixed-length digests are compared without short-circuiting, so the
 * comparison time doesn't depend on how much of the secret matched. An unconfigured secret admits nobody.
 */
export async function matchesSecret(presented: string | undefined, expected: string): Promise<boolean> {
  if (!expected || presented === undefined) return false;
  const [left, right] = await Promise.all([digest(presented), digest(expected)]);
  return left.reduce((difference, byte, index) => difference | (byte ^ (right[index] ?? 0)), 0) === 0;
}
