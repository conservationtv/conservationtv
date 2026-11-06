import { queryOptions } from '@tanstack/react-query';

import { api } from '@/lib/api';

/** How far back a stream card's chart reads, and the bucket it reads it in. */
export const CHART_WINDOW_MS = 3 * 60 * 60 * 1000;
export const CHART_STEP_SECONDS = 120;

export interface MetricRange {
  from: string;
  to: string;
}

/** The organisation's streams, oldest first, each with its exposures and recorders. */
export const streamListQueryOptions = (organisationId: string) =>
  queryOptions({
    queryKey: ['streams', organisationId, 'list'] as const,
    queryFn: async () => {
      const result = await api.organisations.streams.list.v1({ id: organisationId });
      if (result instanceof Error) throw result;
      return result.streams;
    }
  });

/** The organisation's devices, of every kind. */
export const deviceListQueryOptions = (organisationId: string) =>
  queryOptions({
    queryKey: ['devices', organisationId, 'list'] as const,
    queryFn: async () => {
      const result = await api.organisations.devices.list.v1({ id: organisationId });
      if (result instanceof Error) throw result;
      return result.devices;
    }
  });

/** The organisation's cameras, with their state. */
export const cameraListQueryOptions = (organisationId: string) =>
  queryOptions({
    queryKey: ['cameras', organisationId, 'list'] as const,
    queryFn: async () => {
      const result = await api.organisations.cameras.list.v1({ id: organisationId });
      if (result instanceof Error) throw result;
      return result.cameras;
    }
  });

/** The built-in gateways, then the organisation's own. */
export const gatewayListQueryOptions = (organisationId: string) =>
  queryOptions({
    queryKey: ['gateways', organisationId, 'list'] as const,
    queryFn: async () => {
      const result = await api.organisations.gateways.list.v1({ id: organisationId });
      if (result instanceof Error) throw result;
      return result.gateways;
    }
  });

/** The organisation's networks. */
export const networkListQueryOptions = (organisationId: string) =>
  queryOptions({
    queryKey: ['networks', organisationId, 'list'] as const,
    queryFn: async () => {
      const result = await api.organisations.networks.list.v1({ id: organisationId });
      if (result instanceof Error) throw result;
      return result.networks;
    }
  });

/**
 * What agents report about every subject in the organisation (`device:<id>`, `exposure:<id>`), combined: refreshed
 * while the page is open, as a subject goes stale without a new report.
 */
export const subjectStateListQueryOptions = (organisationId: string) =>
  queryOptions({
    queryKey: ['subjects', organisationId, 'states'] as const,
    queryFn: async () => {
      const result = await api.organisations.subjects.states.list.v1({ id: organisationId });
      if (result instanceof Error) throw result;
      return result.states;
    },
    refetchInterval: 30_000
  });

/** A subject's series of one metric, one per reporter, unit and set of dimensions. */
export const metricSeriesQueryOptions = (organisationId: string, subjectId: string, name: string) =>
  queryOptions({
    queryKey: ['subjects', organisationId, subjectId, 'series', name] as const,
    queryFn: async () => {
      const result = await api.organisations.subjects.metrics.list.v1({ id: organisationId, subjectId, name });
      if (result instanceof Error) throw result;
      return result.series;
    }
  });

/** A series' points over a range, in the chart's buckets. */
export const metricPointsQueryOptions = (
  organisationId: string,
  subjectId: string,
  seriesId: string,
  range: MetricRange
) =>
  queryOptions({
    queryKey: ['subjects', organisationId, subjectId, 'points', seriesId, range.from, range.to] as const,
    queryFn: async () => {
      const result = await api.organisations.subjects.metrics.get.v1({
        id: organisationId,
        subjectId,
        seriesId,
        from: range.from,
        to: range.to,
        step: CHART_STEP_SECONDS
      });
      if (result instanceof Error) throw result;
      return result.points;
    }
  });

/** How long before a read connection's credential expires to ask for a fresh one. */
const RENEW_BEFORE_MS = 5 * 60 * 1000;

/**
 * Where to watch an exposure over MoQ, with the short-lived credential that admits this account: the relay URL to dial
 * at the exposure's path, carrying the token as `?jwt=` as the relay reads it, and the broadcast under it to watch. A
 * refusal (no MoQ there, the gateway down) comes back as its message rather than thrown, so a preview can say so in
 * place. Asked again a little before the credential expires.
 */
export const moqReadQueryOptions = (organisationId: string, streamId: string, exposureId: string) =>
  queryOptions({
    queryKey: ['streams', organisationId, 'moq-read', streamId, exposureId] as const,
    queryFn: async () => {
      const result = await api.organisations.streams.exposures.connect.v1({
        id: organisationId,
        streamId,
        exposureId,
        action: 'read',
        protocol: 'moq'
      });
      if (result instanceof Error) return { failure: result.message };
      // A MoQ connection names a relay; any other protocol's is a URL.
      if (!('relay' in result)) return { failure: `The gateway offered ${result.protocol}, not MoQ.` };
      return { url: relayUrl(result), broadcast: result.broadcast, renewIn: renewalDelay(result.expiresAt) };
    },
    staleTime: query => query.state.data?.renewIn ?? 0,
    refetchInterval: query => query.state.data?.renewIn ?? false
  });

/** A MoQ connection as the API describes it: the relay, the exposure's path on it, and the token that admits. */
interface MoqConnection {
  relay: string;
  path: string;
  token?: string;
}

/** The relay URL to dial at the exposure's path, carrying the token as `?jwt=`, as the agent dials it too. */
function relayUrl(connection: MoqConnection): string {
  const url = new URL(connection.path, connection.relay);
  if (connection.token !== undefined) url.searchParams.set('jwt', connection.token);
  return url.href;
}

/** How long until the credential should be renewed: shortly before it expires, and never sooner than a minute. */
function renewalDelay(expiresAt: string | undefined): number {
  if (expiresAt === undefined) return Infinity;
  return Math.max(Date.parse(expiresAt) - Date.now() - RENEW_BEFORE_MS, 60_000);
}
