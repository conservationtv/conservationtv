import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';
import type { PublishConnection } from '@/lib/publishing';

// Going live (docs/shows.md): which of the organisation's deliveries are live, the stream a member goes live on, the
// credential to publish it with, and where an encoder publishes a stream with its key.

/** How often to ask what is live while it is shown: the API keeps each gateway's answer for 5 seconds anyway. */
const LIVE_INTERVAL_MS = 5_000;

/**
 * Each of the organisation's exposures, with whether its gateway says it is live now (null where it cannot say). A
 * show's controls read it to offer a stream that has just gone live; going live reads it to say readers see you.
 */
export const liveExposureListQueryOptions = (organisationId: string) =>
  queryOptions({
    queryKey: ['streams', organisationId, 'live'] as const,
    queryFn: async () => {
      const result = await api.organisations.streams.live.list.v1({ id: organisationId });
      if (result instanceof Error) throw result;
      return result.exposures;
    },
    refetchInterval: LIVE_INTERVAL_MS
  });

/** An exposure, as the live list says of it: its stream, and whether its gateway says it is live. */
export interface LiveExposure {
  streamId: string;
  live: boolean | null;
}

/** The streams with a delivery live now, by ID: what `select` makes of the live list. */
export function liveStreamIds(exposures: LiveExposure[]): Set<string> {
  return new Set(exposures.filter(exposure => exposure.live === true).map(exposure => exposure.streamId));
}

/**
 * The streams every delivery of which its gateway says is not live now: offline for certain, where a gateway that
 * cannot say (null) leaves it unknown.
 */
export function offlineStreamIds(exposures: LiveExposure[]): Set<string> {
  const unsure = new Set(exposures.filter(exposure => exposure.live !== false).map(exposure => exposure.streamId));
  return new Set(exposures.map(exposure => exposure.streamId).filter(streamId => !unsure.has(streamId)));
}

/** Get, or make, the stream the signed-in member goes live on from this kind of device. */
export function useEnsurePersonalStream(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (device: 'phone' | 'computer') => {
      const result = await api.organisations.streams.personal.ensure.v1({ id: organisationId, device });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['streams', organisationId, 'list'] })
  });
}

/** A credential's expiry, as the API gives it. */
export interface Expiring {
  expiresAt?: string;
}

/** A publishing connection, with when its credential expires. */
export type ExpiringConnection = PublishConnection & Expiring;

/** What going live is given to publish with: the exposure chosen, and the connection to it. */
export interface Publishing {
  exposureId: string;
  gatewayId: string;
  connection: ExpiringConnection;
}

/**
 * The credential to publish the stream with, by the first of the protocols that the gateway the API chooses takes,
 * from where its person says they are (`networkId`, null for the internet). Asked again shortly before it expires,
 * and whenever a session is lost: not a query, since it chooses and makes the stream's delivery as it answers.
 */
export async function askToPublish(
  organisationId: string,
  streamId: string,
  protocols: string[],
  networkId: string | null,
  signal?: AbortSignal
): Promise<Publishing> {
  const parameters = { id: organisationId, streamId, action: 'publish' as const, protocols, networkId };
  const result = await api.organisations.streams.connect.v1(parameters, { signal });
  if (result instanceof Error) throw result;
  return result;
}

/** Where an encoder publishes a stream, and its key: made for it if need be, on the network it is on or the internet. */
export function useEnsureEncoder(organisationId: string, streamId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (networkId: string | null) => {
      const result = await api.organisations.streams.encoder.ensure.v1({ id: organisationId, streamId, networkId });
      if (result instanceof Error) throw result;
      return result;
    },
    // It may have made the stream's delivery.
    onSuccess: () => client.invalidateQueries({ queryKey: ['streams', organisationId, 'list'] })
  });
}

/** Replace the stream's key: an encoder with the old one is refused from its next connection on. */
export function useReplaceStreamKey(organisationId: string, streamId: string) {
  return useMutation({
    mutationFn: async () => {
      const result = await api.organisations.streams.key.replace.v1({ id: organisationId, streamId });
      if (result instanceof Error) throw result;
      return result;
    }
  });
}
