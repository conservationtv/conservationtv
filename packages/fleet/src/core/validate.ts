import { isIP } from 'node:net';
import type { SshAccess } from './contracts';

/** Every IPv4 and IPv6 source. */
export const ANYWHERE: readonly string[] = ['0.0.0.0/0', '::/0'];

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const PLACEHOLDER = /REPLACE_WITH|YOUR[_ -]?|<[^>]+>|TODO/i;

export function isDnsLabel(value: string): boolean {
  return DNS_LABEL.test(value);
}

function isHostname(value: string): boolean {
  return value.length <= 253 && value.split('.').every(isDnsLabel);
}

export function assertDnsLabel(value: string, what: string): string {
  if (!isDnsLabel(value)) throw new Error(`${what} "${value}" must be a lowercase DNS label.`);
  return value;
}

/** Lowercases and strips a trailing dot before validating. */
export function readHostname(value: string, what: string): string {
  const hostname = value.toLowerCase().replace(/\.$/, '');
  if (!isHostname(hostname)) throw new Error(`${what} "${value}" must be a valid DNS hostname.`);
  return hostname;
}

export function assertPort(port: number, what: string): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${what} must be an integer port from 1 to 65535, got ${port}.`);
  }
  return port;
}

// Config values often arrive from stack config, where template placeholders slip through.
function rejectPlaceholder(value: string, what: string): void {
  if (!value.trim() || PLACEHOLDER.test(value)) {
    throw new Error(`${what} must be a real, non-empty value (placeholders are not allowed).`);
  }
}

/** An absolute HTTPS URL without credentials, returned without a trailing slash. */
export function readHttpsUrl(value: string, what: string): string {
  rejectPlaceholder(value, what);
  const url = URL.parse(value);
  if (!url || url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`${what} must be an absolute HTTPS URL without credentials.`);
  }
  return url.toString().replace(/\/$/, '');
}

const ADDRESS_BITS = new Map([
  [4, 32],
  [6, 128]
]);

/** An address with a decimal prefix no longer than the address family allows. */
function readCidr(value: string, what: string): string {
  rejectPlaceholder(value, what);
  const cidr = value.trim();
  const [address, prefix = ''] = cidr.split('/');
  const addressBits = ADDRESS_BITS.get(isIP(address));
  if (!addressBits || !/^\d+$/.test(prefix) || Number(prefix) > addressBits) {
    throw new Error(`${what} must be an IPv4 or IPv6 CIDR, got "${value}".`);
  }
  return cidr;
}

/** Validated and deduplicated, preserving order. */
export function readCidrs(values: readonly string[], what: string): string[] {
  return [...new Set(values.map((value, index) => readCidr(value, `${what}[${index}]`)))];
}

/** Rejects port 22 so the bootstrap port is never the scanner default. Empty CIDRs mean anywhere. */
export function readSshAccess(access: SshAccess): SshAccess {
  if (access.port === 22) throw new Error('ssh.port must not be 22.');
  assertPort(access.port, 'ssh.port');
  const allowedCidrs = readCidrs(access.allowedCidrs, 'ssh.allowedCidrs');
  return { port: access.port, allowedCidrs: allowedCidrs.length ? allowedCidrs : ['0.0.0.0/0'] };
}

/** A warning when Docker may resolve a different image on a later pull. */
export function mutableImageWarning(image: string, what: string): string | undefined {
  if (image.includes('@sha256:')) return undefined;
  const hasTag = image.lastIndexOf(':') > image.lastIndexOf('/');
  if (hasTag) return undefined;
  return `${what} uses a mutable image reference (${image}); pin a tag and preferably a digest.`;
}
