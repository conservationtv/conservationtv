import { isIP } from 'node:net';

export interface SshAccessConfig {
  port: number;
  allowedCidrs: string[];
}

type ConfigValue = string | number | boolean | null;

interface SshAccessConfigArgs {
  port?: ConfigValue;
  allowedCidrs?: readonly ConfigValue[];
}

const PLACEHOLDER = /REPLACE_WITH|YOUR[_ -]?|<[^>]+>|TODO/i;

function rejectPlaceholder(value: string, key: string): void {
  if (!value.trim() || PLACEHOLDER.test(value)) {
    throw new Error(`${key} must be a real, non-empty value (placeholders are not allowed).`);
  }
}

export function readSubdomain(value: string, configKey = 'subdomain'): string {
  rejectPlaceholder(value, configKey);
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)) {
    throw new Error(`${configKey} must be a single lowercase DNS label.`);
  }
  return value;
}

// Reject placeholders and malformed URLs before requiring HTTPS with no embedded credentials.
export function readHttpsUrl(value: string, configKey = 'url'): string {
  rejectPlaceholder(value, configKey);
  const url = parseAbsoluteUrl(value, configKey);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw new Error(`${configKey} must be an absolute HTTPS URL without credentials.`);
  }
  return url.toString().replace(/\/$/, '');
}

function parseAbsoluteUrl(value: string, configKey: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${configKey} must be an absolute HTTPS URL.`);
  }
}

// Check the address family and numeric prefix together before accepting a CIDR.
export function readCidr(value: string, configKey = 'CIDR'): string {
  rejectPlaceholder(value, configKey);
  const cidr = value.trim();
  const [address, prefix] = cidr.split('/');
  const bits = isIP(address);
  const prefixNumber = Number(prefix);
  if (!bits || !/^\d+$/.test(prefix ?? '') || prefixNumber < 0 || prefixNumber > bits * 8) {
    throw new Error(`${configKey} must contain valid IPv4 or IPv6 CIDR values.`);
  }
  return cidr;
}

export function readCidrs(values: readonly ConfigValue[], configKey = 'cidrs'): string[] {
  if (!Array.isArray(values)) throw new Error(`${configKey} must be an array of CIDR strings.`);
  return [
    ...new Set(
      values.map((value, index) => {
        if (!isStringValue(value)) throw new Error(`${configKey}[${index}] must be a CIDR string.`);
        return readCidr(value, `${configKey}[${index}]`);
      })
    )
  ];
}

// Default the SSH port and CIDRs, rejecting standard-port or out-of-range access settings.
export function readSshAccessConfig(args: SshAccessConfigArgs, configKey = 'ssh'): SshAccessConfig {
  const port = args.port ?? 2222;
  if (!isNumberValue(port) || !Number.isInteger(port) || port < 1 || port > 65535 || port === 22) {
    throw new Error(`${configKey}.port must be a non-standard TCP port between 1 and 65535.`);
  }
  const cidrs = readCidrs(args.allowedCidrs ?? [], `${configKey}.allowedCidrs`);
  return { port, allowedCidrs: cidrs.length > 0 ? cidrs : ['0.0.0.0/0'] };
}

function isStringValue(value: ConfigValue): value is string {
  return value === String(value);
}

function isNumberValue(value: ConfigValue): value is number {
  return value !== null && value === Number(value);
}

/** Returns a warning when Docker may resolve a different image on a later pull. */
export function imageMutableReferenceWarning(image: string, configKey = 'image'): string | undefined {
  rejectPlaceholder(image, configKey);
  if (image.includes('@sha256:')) return undefined;
  const lastSlash = image.lastIndexOf('/');
  const lastColon = image.lastIndexOf(':');
  if (lastColon > lastSlash) return undefined;
  return `${configKey} uses a mutable image reference (${image}); pin an explicit tag and preferably a digest.`;
}

export const validateImageReference = imageMutableReferenceWarning;
