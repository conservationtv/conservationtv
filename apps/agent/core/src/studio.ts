import type { Client } from '@conservationtv/studio-sdk';
import { createStore } from '@conservationtv/store';

/** The studio API, signed as the agent's device. The agent supplies it on start; runtimes read it with `useStudio()`. */
export const [withStudio, useStudio] = createStore<Client>('studio');

/** The configuration as version 3 of `deviceConfiguration.get` returns it, which names cameras rather than URLs. */
export type ControllingConfiguration = Exclude<Awaited<ReturnType<Client['deviceConfiguration']['get']['v3']>>, Error>;

/** The configuration as version 2 returns it: each path and probe with the URL to pull. */
type ProbingConfiguration = Exclude<Awaited<ReturnType<Client['deviceConfiguration']['get']['v2']>>, Error>;

/**
 * What only version 3 says: the cameras to control, the chat to listen to, and the peers to serve; and who signs each
 * preview's tokens, as signed by no one before it.
 */
type Reach = Partial<Pick<ControllingConfiguration, 'cameras' | 'chat' | 'peers'>> &
  Pick<ControllingConfiguration, 'obs'>;

/**
 * The configuration the agent works from, whichever version the studio API serves: a section for each part of the
 * agent to run (system/configuration.ts), each turned into its keys' specs by that part (gateway/configuration.ts,
 * output/configuration.ts). Its `mediamtx` section is as version 2 gives it, with URLs: from version 3 the agent makes
 * them itself, from the cameras it is given. Its `obs` section is as version 3 gives it.
 */
export type DeviceConfiguration = Omit<ProbingConfiguration, 'obs'> & Reach;

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

/** `url` carrying `token` as `?jwt=`, which relays and gateways read, as the studio API hands them out together. */
export function withToken(url: URL, token: string | undefined): string {
  if (token !== undefined) url.searchParams.set('jwt', token);
  return url.href;
}
