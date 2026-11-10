import {
  queryOptions,
  useMutation,
  useQueryClient,
  type QueryKey,
  type UseSuspenseQueryOptions
} from '@tanstack/react-query';
import type {
  ExposureCreateParams,
  ExposureUpdateParams,
  RecorderCreateParams,
  RecorderUpdateParams,
  Rendition,
  StreamUpdateParams
} from '@conservationtv/studio-sdk';

import { api } from '@/lib/api';
import { Batcher } from '@/lib/batcher';

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

/** What a metric read shares across the subjects it asks about. */
interface MetricFilter {
  organisationId: string;
  names: string[];
  range: MetricRange;
}

/** Metric reads made together, as a page's charts make them, sent as one request across their subjects. */
const metricBatcher = new Batcher({
  request: async ({ organisationId, names, range }: MetricFilter, subjectIds: string[]) => {
    const result = await api.organisations.subjects.metrics.query.v1({
      id: organisationId,
      subjectIds,
      names,
      from: range.from,
      to: range.to,
      step: CHART_STEP_SECONDS
    });
    if (result instanceof Error) throw result;
    return result.series;
  },
  getId: series => series.subjectId,
  maxIds: 100
});

/**
 * Every series of any of the metrics about any of the subjects, one per subject, reporter, unit and set of dimensions,
 * each with its points over the range in the chart's buckets. Read in a batch with other subjects' reads of the same
 * metrics over the same range.
 */
export const metricQueryQueryOptions = (
  organisationId: string,
  subjectIds: string[],
  names: string[],
  range: MetricRange
) =>
  queryOptions({
    queryKey: ['subjects', organisationId, 'metrics', subjectIds, names, range.from, range.to] as const,
    queryFn: () => metricBatcher.load({ organisationId, names, range }, subjectIds)
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
  // Typed by its key's kind rather than its literal shape, so a stream's read and a show's are one type to the parts.
  queryOptions<MoqRead, Error, MoqRead, QueryKey>({
    queryKey: ['streams', organisationId, 'moq-read', streamId, exposureId] as const,
    queryFn: async () =>
      moqReadOf(
        await api.organisations.streams.exposures.connect.v1({
          id: organisationId,
          streamId,
          exposureId,
          action: 'read',
          protocol: 'moq'
        })
      ),
    staleTime: query => readStaleTime(query.state.data),
    refetchInterval: query => readRefetchInterval(query.state.data)
  });

/**
 * How this account reads one rendition of a delivery by one protocol, as the API answers `exposures.connect`: the URL,
 * and the short-lived token the gateway admits it with, which goes beside it (`?jwt=`, or a bearer header). It follows
 * the gateway's URL overrides and what its agent registered, as every reader's does. Kept, like the MoQ preview's, so
 * a copy is ready the moment it is asked for, and asked again a little before the token expires. A refusal (no agent
 * running the gateway, nothing registered for the protocol) comes back as its message, so the protocol says so in place.
 */
export const exposureReadQueryOptions = (
  organisationId: string,
  streamId: string,
  exposureId: string,
  protocol: string,
  rendition: Rendition
) =>
  // As moqReadQueryOptions: one type for a stream's read and a show's.
  queryOptions<ProtocolRead, Error, ProtocolRead, QueryKey>({
    queryKey: ['streams', organisationId, 'read', streamId, exposureId, protocol, rendition] as const,
    queryFn: async () =>
      protocolReadOf(
        await api.organisations.streams.exposures.connect.v1({
          id: organisationId,
          streamId,
          exposureId,
          action: 'read',
          protocol,
          rendition
        })
      ),
    staleTime: query => readStaleTime(query.state.data),
    refetchInterval: query => readRefetchInterval(query.state.data)
  });

/**
 * A read connection as the API gives one, for an exposure or a show's preview alike: a MoQ relay, the path on it and
 * the broadcast under it; or, for any other protocol, a URL. Either carries the token that admits, and when it expires.
 */
type ReadConnection = MoqConnectionAnswer | UrlConnectionAnswer;

/** A MoQ connection: the relay, the path on it and the broadcast under it. */
interface MoqConnectionAnswer {
  protocol: 'moq';
  relay: string;
  path: string;
  broadcast: string;
  token?: string;
  expiresAt?: string;
}

/** Any other protocol's connection: a URL. */
interface UrlConnectionAnswer {
  protocol: string;
  url: string;
  token?: string;
  expiresAt?: string;
}

/** Why a reader can't read something, in the API's words: what a read says in place of its buttons. */
export interface ReadRefused {
  failure: string;
}

/** How to read over MoQ: the relay URL with the token in it, the broadcast, and when to ask again. */
export interface MoqReadable {
  url: string;
  broadcast: string;
  renewIn: number;
}
export type MoqRead = MoqReadable | ReadRefused;

/** How to read by one protocol: its URL, the token that goes beside it, and when to ask again. */
export interface ProtocolReadable {
  url: string;
  token?: string;
  expiresAt?: string;
  renewIn: number;
}
export type ProtocolRead = ProtocolReadable | ReadRefused;

/** A query for a MoQ read, of a stream's delivery or a show's preview: what the reading parts are given. */
export type MoqReadQueryOptions = UseSuspenseQueryOptions<MoqRead, Error, MoqRead, QueryKey>;

/** A query for one protocol's read, of a stream's delivery or a show's preview. */
export type ProtocolReadQueryOptions = UseSuspenseQueryOptions<ProtocolRead, Error, ProtocolRead, QueryKey>;

/** How long a read stays fresh: until a little before its credential expires. A refusal is asked again when next shown. */
export function readStaleTime(read: MoqRead | ProtocolRead | undefined): number {
  return read && 'renewIn' in read ? read.renewIn : 0;
}

/** When to ask for a read again while it is shown: a little before its credential expires; a refusal, not on a timer. */
export function readRefetchInterval(read: MoqRead | ProtocolRead | undefined): number | false {
  return read && 'renewIn' in read ? read.renewIn : false;
}

/** A MoQ read from the API's answer, or why there isn't one. */
export function moqReadOf(result: ReadConnection | Error): MoqRead {
  if (result instanceof Error) return { failure: result.message };
  // A MoQ connection names a relay; any other protocol's is a URL.
  if (!('relay' in result)) return { failure: `The gateway offered ${result.protocol}, not MoQ.` };
  return { url: relayUrl(result), broadcast: result.broadcast, renewIn: renewalDelay(result.expiresAt) };
}

/** A protocol's read from the API's answer, or why there isn't one. */
export function protocolReadOf(result: ReadConnection | Error): ProtocolRead {
  if (result instanceof Error) return { failure: result.message };
  // A MoQ connection names a relay; every other protocol's is a URL.
  if ('relay' in result) return { failure: 'It is read over MoQ here.' };
  return { url: result.url, token: result.token, expiresAt: result.expiresAt, renewIn: renewalDelay(result.expiresAt) };
}

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

/** Rename a stream, or change the device it comes from. */
export function useUpdateStream(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (changes: Omit<StreamUpdateParams, 'id'>) => {
      const result = await api.organisations.streams.update.v1({ id: organisationId, ...changes });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['streams', organisationId, 'list'] })
  });
}

/** Delete a stream, with its exposures and recorders. */
export function useDeleteStream(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (streamId: string) => {
      const result = await api.organisations.streams.delete.v1({ id: organisationId, streamId });
      if (result instanceof Error) throw result;
    },
    // Not waited on: the page that deleted it leaves at once, instead of showing "not found" while its list is read.
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['streams', organisationId, 'list'] });
    }
  });
}

/** Deliver a stream to a gateway: a new exposure, fed by the source or by another of the stream's exposures. */
export function useCreateExposure(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (exposure: Omit<ExposureCreateParams, 'id'>) => {
      const result = await api.organisations.streams.exposures.create.v1({ id: organisationId, ...exposure });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['streams', organisationId, 'list'] })
  });
}

/** Change an exposure: its gateway, the renditions it offers, what feeds it, or who publishes it. */
export function useUpdateExposure(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (changes: Omit<ExposureUpdateParams, 'id'>) => {
      const result = await api.organisations.streams.exposures.update.v1({ id: organisationId, ...changes });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['streams', organisationId, 'list'] })
  });
}

/** What names one of a stream's exposures or recorders, to remove it. */
export interface StreamPartRemoval {
  streamId: string;
  partId: string;
}

/** Stop delivering a stream to a gateway. Refused while another exposure or a recorder still depends on it. */
export function useDeleteExposure(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ streamId, partId }: StreamPartRemoval) => {
      const result = await api.organisations.streams.exposures.delete.v1({
        id: organisationId,
        streamId,
        exposureId: partId
      });
      if (result instanceof Error) throw result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['streams', organisationId, 'list'] })
  });
}

/** Record one of a stream's exposures, at one of the renditions it offers. */
export function useCreateRecorder(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (recorder: Omit<RecorderCreateParams, 'id'>) => {
      const result = await api.organisations.streams.recorders.create.v1({ id: organisationId, ...recorder });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['streams', organisationId, 'list'] })
  });
}

/** Change what a recorder records, or how. */
export function useUpdateRecorder(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (changes: Omit<RecorderUpdateParams, 'id'>) => {
      const result = await api.organisations.streams.recorders.update.v1({ id: organisationId, ...changes });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['streams', organisationId, 'list'] })
  });
}

/** Stop recording an exposure. */
export function useDeleteRecorder(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ streamId, partId }: StreamPartRemoval) => {
      const result = await api.organisations.streams.recorders.delete.v1({
        id: organisationId,
        streamId,
        recorderId: partId
      });
      if (result instanceof Error) throw result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['streams', organisationId, 'list'] })
  });
}

/** One of a new stream's first deliveries, named by its gateway; what feeds it is another of them, by its gateway. */
export interface NewStreamDelivery {
  gatewayId: string;
  /** The gateway's name, for saying which delivery was refused. */
  name: string;
  upstreamGatewayId: string | null;
  renditions: ExposureCreateParams['renditions'];
  publisherDeviceId: string | null;
}

/** A stream to create, and its deliveries in the order they are to be made: each after whatever feeds it. */
export interface NewStreamWithDeliveries {
  name: string;
  sourceDeviceId: string | null;
  deliveries: NewStreamDelivery[];
}

/**
 * Create a stream, then its deliveries one after another, each fed by the exposure made for its upstream. A refused
 * stream throws; once the stream exists, a refused delivery stops the rest and comes back as `failure`, so the stream
 * is never lost and the page can say what wasn't made. Administrators only.
 */
export function useCreateStreamWithDeliveries(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, sourceDeviceId, deliveries }: NewStreamWithDeliveries) => {
      const stream = await api.organisations.streams.create.v1({ id: organisationId, name, sourceDeviceId });
      if (stream instanceof Error) throw stream;
      const made = new Map<string, string>();
      // Each delivery needs the ID of the exposure made for its upstream, so they are made in turn. Once the stream
      // exists, a delivery that fails for any reason, refused or never sent, is reported with the stream rather than
      // thrown: pressing Create again would make a second stream.
      for (const delivery of deliveries) {
        const upstreamExposureId = delivery.upstreamGatewayId ? (made.get(delivery.upstreamGatewayId) ?? null) : null;
        const exposure = await api.organisations.streams.exposures.create
          .v1({
            id: organisationId,
            streamId: stream.id,
            gatewayId: delivery.gatewayId,
            renditions: delivery.renditions,
            publisherDeviceId: delivery.publisherDeviceId,
            upstreamExposureId
          })
          .catch((error: Error) => error);
        if (exposure instanceof Error) {
          return { stream, failure: `The delivery to ${delivery.name} wasn’t made: ${exposure.message}` };
        }
        made.set(delivery.gatewayId, exposure.id);
      }
      return { stream, failure: null };
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['streams', organisationId, 'list'] })
  });
}
