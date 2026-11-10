// An iroh endpoint ticket for a device on a known relay, written here because the browser binding dials tickets only,
// where the Node binding takes an endpoint ID and relay URL directly (apps/cli/src/iroh.ts). The format is iroh's own:
// the word `endpoint`, then unpadded lowercase base32 of the postcard encoding of
//
//   variant 0 · the 32-byte endpoint ID · a list of addresses, each a variant (0: a relay) and its URL as a string
//
// so a ticket made here parses to the same address `EndpointTicket.fromAddr(new EndpointAddr(id, relayUrl))` holds.

const TICKET_PREFIX = 'endpoint';
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
/** postcard's tag for the ticket format in use, and for a relay among an endpoint's addresses. */
const TICKET_VARIANT = 0;
const RELAY_ADDRESS_VARIANT = 0;

/** The bytes of a device's public ID: an Ed25519 public key in lowercase hex. */
function publicIdBytes(publicId: string): number[] {
  if (!/^[0-9a-f]{64}$/.test(publicId)) throw new Error(`"${publicId}" is not a device's public ID`);
  const pairs = publicId.match(/../g) ?? [];
  return pairs.map(pair => Number.parseInt(pair, 16));
}

/** A length as postcard writes it: seven bits at a time, lowest first, the top bit set on all but the last byte. */
function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return bytes;
}

function base32(bytes: number[]): string {
  let text = '';
  let bits = 0;
  let pending = 0;
  for (const byte of bytes) {
    pending = (pending << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      text += BASE32_ALPHABET[(pending >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) text += BASE32_ALPHABET[(pending << (5 - bits)) & 31];
  return text;
}

/** The ticket for the device with this public ID, reached at its endpoint ID on the relay alone. */
export function relayTicket(publicId: string, relayUrl: string): string {
  // As iroh normalises a relay URL: an origin gains its trailing slash.
  const url = new TextEncoder().encode(new URL(relayUrl).href);
  const bytes = [
    TICKET_VARIANT,
    ...publicIdBytes(publicId),
    ...varint(1),
    RELAY_ADDRESS_VARIANT,
    ...varint(url.length),
    ...url
  ];
  return TICKET_PREFIX + base32(bytes);
}
