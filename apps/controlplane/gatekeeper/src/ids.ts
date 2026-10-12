const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A prefixed ULID, e.g. `grt_01J2M5X9C7KZT3T4X0W6MQ8J62`: 48 bits of time then 80 random bits, sortable by time. */
export function newId(prefix: 'grt' | 'irl', now: number): string {
  let time = '';
  for (let remaining = now, index = 0; index < 10; index++, remaining = Math.floor(remaining / 32)) {
    time = CROCKFORD[remaining % 32] + time;
  }
  // 256 is a multiple of 32, so each byte modulo 32 is uniform.
  const random = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => CROCKFORD[byte % 32]).join('');
  return `${prefix}_${time}${random}`;
}
