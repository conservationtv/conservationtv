import { X509Certificate } from 'node:crypto';
import { getLogger } from '@logtape/logtape';
import { z } from 'zod';

const logger = getLogger(['agent', 'mediamtx', 'webtransport']);

// Node has no WebTransport, so @moq/net dials relays from the agent over WebSocket instead, which the conservation.tv
// relay accepts and Cloudflare's refuses (403). @fails-components/webtransport gives Node one, over HTTP/3 by the
// native addon in @fails-components/webtransport-transport-http3-quiche, an optional dependency with prebuilt binaries
// for macOS and glibc Linux (x64, arm64) and Windows (x64) only. Where it does not load, as in the Alpine image, nothing
// is installed and relays are dialled over WebSocket as before: Cloudflare MoQ gateways then cannot be joined.
//
// The polyfill would fall back to WebTransport over HTTP/2 without the addon, which no MoQ relay serves, so the addon
// is loaded first and the polyfill only installed once it has. With it, @moq/net tries WebTransport first and falls
// back to WebSocket after a head start, so relays that only take WebSocket are still reached.
//
// The addon has its server's certificate chain checked by a global hook the transport defines, `FAILSVerifyProof`
// (lib/socket.js): the leaf names the host, every certificate is in date, each is signed by the next, and the last by
// one of Node's root CAs. It never checks that the certificates signing others are CAs, so a leaf certificate for any
// name could sign one for the relay's and pass: `requireIssuingCas` adds that, which a relay-wide token is worth.
//
// Both are loaded by name at runtime, unresolved by TypeScript (they export only under the `node` condition) and left
// out of the runner's bundle (the addon cannot be bundled), so what the polyfill exports is checked here.

/** The HTTP/3 transport's native addon, loaded only to learn whether it can be. */
const TRANSPORT_MODULE = '@fails-components/webtransport-transport-http3-quiche';
const POLYFILL_MODULE = '@fails-components/webtransport';

/** What is read of the polyfill: its WebTransport, the DOM's shape, and when its HTTP/3 transport has settled. */
const PolyfillSchema = z.object({
  // SAFETY: the polyfill's WebTransport is a class implementing the DOM's WebTransport, which it declares itself as.
  WebTransport: z.instanceof(Function).transform(constructor => constructor as typeof globalThis.WebTransport),
  quicheLoaded: z.custom<Promise<unknown>>(value => value instanceof Promise)
});
type Polyfill = z.output<typeof PolyfillSchema>;

/** What the transport passes its hook: the server's chain, leaf first, as DER, beside fields only it reads. */
const ProofSchema = z.object({ certs: z.array(z.instanceof(Uint8Array)) });
type Proof = z.output<typeof ProofSchema>;

/** The transport's hook: a chain is accepted only if it returns true. */
type Verifier = (proof: Proof) => boolean;

/** The global the transport defines its hook on, once its addon has loaded. */
const HookedGlobalSchema = z.object({
  // SAFETY: the transport defines the hook as a function of the proof returning whether to accept it (lib/socket.js).
  FAILSVerifyProof: z.instanceof(Function).transform(verifier => verifier as Verifier)
});
type HookedGlobal = z.output<typeof HookedGlobalSchema>;

/** Whether every certificate in the chain but the leaf may sign others: an issuing CA, by its basic constraints. */
function issuedByCas(proof: Proof): boolean {
  const [, ...issuers] = proof.certs;
  return issuers.every(der => new X509Certificate(der).ca);
}

/** Wraps the transport's certificate check so a chain must also be issued by CAs throughout; throws without one. */
function requireIssuingCas(): void {
  const hooked: HookedGlobal = HookedGlobalSchema.parse(globalThis);
  const verify = hooked.FAILSVerifyProof;
  // The transport's own check first: it refuses a chain without certificates, so this never reads a missing one.
  const strict: Verifier = proof => verify(proof) && issuedByCas(proof);
  Object.assign(globalThis, { FAILSVerifyProof: strict });
}

/** Whether WebTransport is installed, once settled; asked for once. */
let installing: Promise<boolean> | undefined = undefined;

/** The polyfill, with its HTTP/3 transport loaded; throws if either cannot be. */
async function loadPolyfill(): Promise<Polyfill> {
  await import(TRANSPORT_MODULE);
  const loaded: unknown = await import(POLYFILL_MODULE);
  const polyfill = PolyfillSchema.parse(loaded);
  await polyfill.quicheLoaded;
  return polyfill;
}

/** Installs the HTTP/3 polyfill as the global `WebTransport`, unless one is already there or it cannot load. */
async function install(): Promise<boolean> {
  if ('WebTransport' in globalThis) return true;
  try {
    const { WebTransport } = await loadPolyfill();
    requireIssuingCas();
    Object.assign(globalThis, { WebTransport });
  } catch (error) {
    logger.warn('No HTTP/3 WebTransport, so relays are dialled over WebSocket: {error}', { error });
    return false;
  }
  logger.info('Relays are dialled over HTTP/3 WebTransport');
  return true;
}

/** Gives Node WebTransport for dialling MoQ relays, where it can; resolves whether it did. Safe to call repeatedly. */
export function installWebTransport(): Promise<boolean> {
  if (installing === undefined) installing = install();
  return installing;
}
