import type { Client } from '@conservationtv/studio-sdk';
import { createStore } from '@conservationtv/store';

/** The studio API, signed as the agent's device. The agent supplies it on start; runtimes read it with `useStudio()`. */
export const [withStudio, useStudio] = createStore<Client>('studio');

/**
 * The configuration as version 4 of `deviceConfiguration.get` returns it, which names cameras rather than URLs, and
 * serves each exposure at one path.
 */
export type DeliveringConfiguration = Exclude<Awaited<ReturnType<Client['deviceConfiguration']['get']['v4']>>, Error>;

/** The `mediamtx` section as version 4 gives it. */
type DeliveringMediamtx = NonNullable<DeliveringConfiguration['mediamtx']>;

/** Where a path is pulled from while it is read: a URL, credentials included, such as a camera's. */
export interface UrlSource {
  url: string;
}

/** Another path of the same MediaMTX, which a path is read from while it is read. */
export interface PathSource {
  path: string;
}

/**
 * A path as the gateway works from it: with the URL to pull, or another of its paths; or none, a pushed stream's
 * ingest, which its publisher pushes to, an encoder admitted by the stream's key whose digest is `keySha256`.
 */
export interface PulledPath extends Omit<DeliveringMediamtx['paths'][number], 'source'> {
  source?: UrlSource | PathSource;
  keySha256?: string;
}

/** A camera to probe, as the probes work from it: the URL to ask for a stream description, credentials included. */
export interface UrlProbe {
  subjectId: string;
  url: string;
}

/** The `mediamtx` section the agent works from: as version 4 gives it, with URLs where it names cameras. */
export interface MediamtxSection extends Omit<DeliveringMediamtx, 'paths' | 'probes'> {
  paths: PulledPath[];
  probes: UrlProbe[];
}

/**
 * What only version 3 and later say: the cameras to control, the chat to listen to, and the peers to serve; and who
 * signs each preview's tokens, as signed by no one before it.
 */
type Reach = Partial<Pick<DeliveringConfiguration, 'cameras' | 'chat' | 'peers'>> &
  Pick<DeliveringConfiguration, 'obs' | 'show'>;

/**
 * The `relays` section as version 4 gives it: where to read the relays' stats, and the exposures the agent covers but
 * does not publish. Versions before 4 name only the stats, in their `mediamtx` section, and nothing to watch.
 */
export type RelaysSection = NonNullable<DeliveringConfiguration['relays']>;

/**
 * The configuration the agent works from, whichever version the studio API serves: a section for each part of the
 * agent to run (system/configuration.ts), each turned into its keys' specs by that part (gateway/configuration.ts,
 * output/configuration.ts). Its `mediamtx` section is as version 4 gives it, with URLs: from version 3 the agent makes
 * them itself, from the cameras it is given. Its `obs` section is as version 3 and later give it, and its `relays` as
 * version 4 does.
 */
export interface DeviceConfiguration extends Reach {
  mediamtx?: MediamtxSection;
  relays?: RelaysSection;
}

/**
 * How long before a credential the studio API hands out expires it is asked for again: longer than the configuration's
 * interval (system/configuration.ts), so one ask always catches it.
 */
const RENEW_BEFORE_MS = 10 * 60_000;

/** A credential the studio API hands out: valid until `expiresAt` when it says, for good when it doesn't. */
export interface Expiring {
  expiresAt?: string;
}

/** When a credential expires, in milliseconds since the epoch: never, when it doesn't say. */
export function expiryOf(credential: Expiring): number {
  if (credential.expiresAt === undefined) return Infinity;
  return Date.parse(credential.expiresAt);
}

/**
 * The credential kept in `leases` under `id`, or a new one from `ask`, kept from then on, when none is or it expires
 * within `RENEW_BEFORE_MS`. Throws the error `ask` returns, keeping what was kept.
 */
export async function leased<Lease extends Expiring>(
  leases: Map<string, Lease>,
  id: string,
  ask: () => Promise<Lease | Error>
): Promise<Lease> {
  const kept = leases.get(id);
  if (kept !== undefined && expiryOf(kept) - Date.now() >= RENEW_BEFORE_MS) return kept;
  const renewed = await ask();
  if (renewed instanceof Error) throw renewed;
  leases.set(id, renewed);
  return renewed;
}

/**
 * Forgets every lease in `leases` but those under `kept`: one for something the configuration no longer names would
 * otherwise be kept for good.
 */
export function keepLeases(leases: Map<string, unknown>, kept: Iterable<string>): void {
  const keep = new Set(kept);
  for (const id of leases.keys()) if (!keep.has(id)) leases.delete(id);
}

/** `url` carrying `token` as `?jwt=`, which relays and gateways read, as the studio API hands them out together. */
export function withToken(url: URL, token: string | undefined): string {
  if (token !== undefined) url.searchParams.set('jwt', token);
  return url.href;
}
