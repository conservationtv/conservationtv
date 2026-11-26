import { and, eq, isNull, sql } from 'drizzle-orm';
import { exposures, gateways, streams } from '../db/schema.ts';
import { transaction, trustedTransaction, useDB } from '../db/transaction.ts';
import { ApiFailure } from '../errors.ts';
import { useDevice } from '../middleware/device.ts';
import { usePrincipal, useUser } from '../middleware/principal.ts';
import { selectRegisteredProtocols } from '../services/gateway-endpoints.ts';
import { ensureStreamKey, requireOwnStream, requirePublisher, selectBrowserUser } from '../services/publishing.ts';
import { checkGateway } from '../topology/exposures.ts';
import type { Settings } from '../topology/settings.ts';
import { chooseIngest, type IngestCandidate } from './delivery.ts';
import { selectGateway } from './connect.ts';
import { BUILTIN_GATEWAYS, BUILTIN_GATEWAY_IDS, gatewayProvider } from './index.ts';
import { servedProtocols, type ConnectionDetails, type EncoderServer } from './provider.ts';

// Going live (docs/shows.md): publishing a pushed stream, one with no source device of its own (a phone, a PC, OBS).
// The stream stands; its deliveries are made when they are needed. Someone going live says what they can send, and,
// since the API cannot tell for a browser or an encoder, whether they are on one of the organisation's networks; the
// API picks the gateway as a reader's is picked (`chooseIngest`, src/gateways/delivery.ts) and makes sure the chain
// exists, in one trusted transaction, once `requirePublisher` has decided what row-level security would:
//
//   ingest  an exposure of the stream at that gateway, with no upstream and no pinned publisher: what is published to;
//   onward  at a gateway other than conservation.tv, an exposure at conservation.tv whose upstream is the ingest, which
//           the agent running the ingest's gateway republishes by MoQ, as it does a camera's (src/configuration/plan).
//
// They are plumbing, made once and kept, so a URL an encoder saved keeps working. Then the publisher is given a
// short-lived credential for the ingest at its gateway, as a reader is given one to read (`publishStream`), or, for an
// encoder that only takes a URL, where to publish with the stream's key (`encoderIngest`).
//
// Who publishes: a member with the right to (`streamPublisher`, which administrators hold), signed in, or their
// browser's own device, signing as it, on their behalf. No other device publishes a pushed stream. A member's personal
// stream (src/db/schemas/publishing.ts) is published by that member alone; any publisher publishes a shared one.

/** The gateway conservation.tv readers watch from, which an ingest elsewhere is republished to. */
const ONWARD_GATEWAY = 'conservationtv';

/** What a publisher asks: the protocols it can send, in its order of preference, and the network it is on, if any. */
export interface PublishAsk {
  protocols: string[];
  networkId: string | null;
}

/** A stream, by where it is published: `organisations/{organisationId}/streams/{streamId}`. */
export interface PublishLocation {
  organisationId: string;
  streamId: string;
}

/** The protocols an encoder that only takes a URL can send, in the order it is offered them. */
const ENCODER_PROTOCOLS = ['rtmps', 'rtmp', 'webrtc'];

/** The member the caller publishes for: themselves, or the member whose browser's device signed. `forbidden` for any other device. */
async function publishingUser(organisationId: string) {
  const caller = usePrincipal();
  if (caller.kind !== 'device') return caller.id;
  const device = useDevice();
  if (device.organisationId !== organisationId) throw new ApiFailure('not_found');
  const userId = await trustedTransaction(() => selectBrowserUser(organisationId, device.id), {
    name: 'publish.browser'
  });
  if (userId === undefined) throw new ApiFailure('forbidden');
  return userId;
}

/**
 * Every gateway of the organisation's and the built-in ones, as ingest candidates, each by the protocols it has a
 * server for now (`servedProtocols`), so a publisher is never handed one to be refused `gateway_unavailable`: built in
 * first, then oldest first.
 */
async function ingestCandidates(organisationId: string): Promise<IngestCandidate[]> {
  const db = useDB();
  const own = await db
    .select({ id: gateways.id, kind: gateways.kind, networkId: gateways.networkId, settings: gateways.settings })
    .from(gateways)
    .where(eq(gateways.organisationId, organisationId))
    .orderBy(gateways.id);
  const served = await selectRegisteredProtocols(organisationId);
  const builtin = BUILTIN_GATEWAY_IDS.map(id => ({
    gatewayId: id,
    networkId: null,
    ingest: BUILTIN_GATEWAYS[id].ingest
  }));
  const registered = own.flatMap(gateway => {
    const ingest = ingestOf(gateway, served.get(gateway.id) ?? new Set());
    return ingest.length === 0 ? [] : [{ gatewayId: gateway.id, networkId: gateway.networkId, ingest }];
  });
  return [...builtin, ...registered];
}

/** One of the organisation's gateways, as an ingest candidate is read. */
interface OwnGateway {
  id: string;
  kind: string;
  settings: Settings;
}

/** The protocols a gateway is published to that it has a server for now: none for a kind with no provider. */
function ingestOf(gateway: OwnGateway, registered: ReadonlySet<string>): readonly string[] {
  try {
    const provider = gatewayProvider(gateway.id, gateway.kind);
    return servedProtocols(provider, 'ingest', registered, gateway.settings);
  } catch {
    return [];
  }
}

/** The stream's exposure at the gateway that nothing feeds but its publisher, if it has one. */
async function selectIngest(streamId: string, gatewayId: string) {
  const db = useDB();
  const [row] = await db
    .select({ id: exposures.id })
    .from(exposures)
    .where(
      and(
        eq(exposures.streamId, streamId),
        eq(exposures.gatewayId, gatewayId),
        isNull(exposures.upstreamExposureId),
        isNull(exposures.publisherDeviceId)
      )
    )
    .orderBy(exposures.id)
    .limit(1);
  return row?.id;
}

/** Whether the stream has an exposure at the gateway fed by this one. */
async function hasOnward(streamId: string, gatewayId: string, upstreamExposureId: string) {
  const db = useDB();
  const [row] = await db
    .select({ id: exposures.id })
    .from(exposures)
    .where(
      and(
        eq(exposures.streamId, streamId),
        eq(exposures.gatewayId, gatewayId),
        eq(exposures.upstreamExposureId, upstreamExposureId)
      )
    )
    .limit(1);
  return row !== undefined;
}

/**
 * The stream's ingest at the gateway, made if it has none, and its onward hop to conservation.tv for a gateway that is
 * not conservation.tv, with whether either was made now (a change of configuration, audited as one). One chain change
 * of the stream at a time: the same lock `checkChain` takes.
 */
async function ensureChain(organisationId: string, streamId: string, gatewayId: string) {
  const db = useDB();
  await checkGateway(organisationId, gatewayId);
  await db.execute(sqlChainLock(streamId));
  const existing = await selectIngest(streamId, gatewayId);
  const ingestId = existing ?? (await insertExposure(organisationId, streamId, gatewayId, null));
  const onward = gatewayId !== ONWARD_GATEWAY && !(await hasOnward(streamId, ONWARD_GATEWAY, ingestId));
  if (onward) await insertExposure(organisationId, streamId, ONWARD_GATEWAY, ingestId);
  return { ingestId, made: existing === undefined || onward };
}

/** A new exposure of the stream, unpinned: the system decides who sends it. */
async function insertExposure(organisationId: string, streamId: string, gatewayId: string, upstream: string | null) {
  const db = useDB();
  const [row] = await db
    .insert(exposures)
    .values({ organisationId, streamId, gatewayId, publisherDeviceId: null, upstreamExposureId: upstream, params: {} })
    .returning({ id: exposures.id });
  return row!.id;
}

/** Serialises changes to one stream's chain, as `checkChain` (src/topology/exposures.ts) does. */
function sqlChainLock(streamId: string) {
  return sql`select pg_advisory_xact_lock(hashtextextended(${`exposure-chain:${streamId}`}, 0))`;
}

/**
 * Where the user publishes the stream, decided and made in one trusted transaction: `not_found` for a stream they
 * cannot see, `forbidden` unless they may publish or for someone else's personal stream, `not_pushed` for a stream
 * with a source of its own, and `no_ingest` when no gateway they reach is published to by a protocol they named. With
 * whether its chain was made now.
 */
function ingestTarget(location: PublishLocation, userId: string, ask: PublishAsk) {
  const { organisationId, streamId } = location;
  return trustedTransaction(
    async () => {
      await requirePublisher(organisationId, userId);
      const db = useDB();
      const [stream] = await db
        .select({ sourceDeviceId: streams.sourceDeviceId })
        .from(streams)
        .where(and(eq(streams.organisationId, organisationId), eq(streams.id, streamId)))
        .for('update');
      if (stream === undefined) throw new ApiFailure('not_found');
      if (stream.sourceDeviceId !== null) throw new ApiFailure('not_pushed');
      await requireOwnStream(organisationId, streamId, userId);
      const candidates = await ingestCandidates(organisationId);
      const chosen = chooseIngest(candidates, ask);
      if (chosen === undefined) throw new ApiFailure('no_ingest');
      const { ingestId, made } = await ensureChain(organisationId, streamId, chosen.candidate.gatewayId);
      const gateway = await selectGateway(organisationId, chosen.candidate.gatewayId);
      return { exposureId: ingestId, gateway, protocol: chosen.protocol, made };
    },
    { name: 'publish.ingest' }
  );
}

/**
 * Publish a pushed stream: the ingest chosen and made for the caller (`exposureId`, at `gatewayId`), and a short-lived
 * credential to publish it there by the first protocol it named that the gateway is published to; with whether its
 * exposures were made now (`made`), which the API keeps an audit entry of.
 */
export async function publishStream(location: PublishLocation, ask: PublishAsk) {
  const caller = usePrincipal();
  const userId = await publishingUser(location.organisationId);
  const { exposureId, gateway, protocol, made } = await ingestTarget(location, userId, ask);
  const provider = gatewayProvider(gateway.id, gateway.kind);
  const connection: ConnectionDetails = await provider.connect(
    {
      organisationId: location.organisationId,
      gatewayId: gateway.id,
      delivery: { id: exposureId },
      subject: `${caller.kind}:${caller.id}`,
      action: 'publish',
      protocol
    },
    gateway.settings
  );
  return { exposureId, gatewayId: gateway.id, connection, made };
}

/**
 * Where an encoder that only takes a URL publishes the stream: its standing ingest at a gateway that admits an encoder
 * by the stream's key, on the network the member says it is on or the internet, made if need be; the key, read in the
 * member's request session (made now if the stream has none); and, for each protocol the gateway's servers are known
 * for, what to paste. Members only, with the right to publish. `gateway_unavailable` when none of its servers is
 * known, as while no agent runs it.
 */
export async function encoderIngest(location: PublishLocation, networkId: string | null) {
  const member = useUser();
  const ask = { protocols: ENCODER_PROTOCOLS, networkId };
  const { exposureId, gateway } = await ingestTarget(location, member.id, ask);
  const { key, createdAt } = await transaction(() => ensureStreamKey(location.organisationId, location.streamId));
  const provider = gatewayProvider(gateway.id, gateway.kind);
  const request = { organisationId: location.organisationId, gatewayId: gateway.id, delivery: { id: exposureId }, key };
  const servers: EncoderServer[] = provider.encoder ? await provider.encoder(request, gateway.settings) : [];
  if (servers.length === 0) throw new ApiFailure('gateway_unavailable', { cause: 'No server of the gateway is known' });
  return { exposureId, gatewayId: gateway.id, key, keyCreatedAt: createdAt, servers };
}
