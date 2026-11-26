import { exposureSubject, pathMetrics } from '@conservationtv/reports';
import { and, eq } from 'drizzle-orm';
import { importJWK, SignJWT } from 'jose';
import { z } from 'zod';
import { agents, devices, gateways } from '../db/schema.ts';
import { trustedTransaction, useDB } from '../db/transaction.ts';
import { ApiFailure } from '../errors.ts';
import { useEnvironment } from '../env/env.ts';
import { registeredEndpointUrls } from '../services/gateway-endpoints.ts';
import { latestPoints } from '../services/subjects.ts';
import { MEDIAMTX_PROTOCOLS, type MediamtxProtocol } from './mediamtx-protocols.ts';
import { CONNECTION_LIFETIME_SECONDS, provider, type ConnectionAction, type ConnectionRequest } from './provider.ts';

// MediaMTX gateways admit connections by JWTs this API signs with the identity of the agent running the gateway: the
// network's active agent's own Ed25519 key, which this API holds (src/topology/identity.ts) and the agent verifies
// against on its own (apps/agent/core/src/gateway/streams/auth.ts), with nothing to fetch from here. A token is
// issued by `<APP_URL>`, for the gateway's ID as its audience, and admits one action on one path, at only the gateway
// it was issued for. The agent also admits readers on its own machine without one. A MediaMTX run any other way can
// check them itself (`authMethod: jwt`) against the JWKS the agent serves.
//
// Where each of its protocols' servers listens is what the agent running it registered (src/services/gateway-endpoints.ts)
// from what its MediaMTX actually listens on. The gateway's settings may override a protocol's, for a reverse proxy in
// front of it, say. A protocol with neither has no server to connect to, so choosing a delivery or an ingest counts
// only the others (`served`): a reader or publisher is never handed this gateway to be refused `gateway_unavailable`.
//
// What is live on it is what the agent running it last said of each path: a delivery is live while its path is ready
// (`path.ready`; an agent from before a delivery had one path may say so of several), as reported within the last few
// report intervals. One nothing has said
// anything of so recently, as while no agent runs the gateway, it cannot say of.

/** How recent a path's last report must be to say whether it is ready now: three of the agent's 15-second reports. */
const READY_REPORT_SECONDS = 45;

/** How gateway tokens are signed: by the agent's Ed25519 identity, as JOSE names it. */
const GATEWAY_SIGNING_ALGORITHM = 'EdDSA';

// Every MediaMTX protocol carries one path per connection, and a delivery is one path: the one picture its source
// gives. HLS serves its playlist with no master playlist of other sizes.
const INGEST = ['webrtc', 'rtsp', 'rtsps', 'rtmp', 'rtmps'] as const;
const EGRESS = [...INGEST, 'hls'] as const;

/**
 * Where the gateway's protocols' servers listen, as its network reaches them, in place of what the agent running it
 * registered: none, to use those.
 */
const MediamtxSettingsSchema = z.strictObject({
  urls: z.partialRecord(z.enum(MEDIAMTX_PROTOCOLS), z.url()).default({})
});
export type MediamtxSettings = z.output<typeof MediamtxSettingsSchema>;

/**
 * The MediaMTX path an exposure or a preview is served at, by its ID: `<id>/live`, as its MoQ broadcast is
 * `<id>/live.hang`. Agents are told every path's name (src/configuration/plan) and never make one up, so any agent
 * serves what this says. Two segments, since RTMP reads a path as its app and stream key: the moq CLI that publishes
 * an exposure from its path refuses an RTMP URL with one.
 */
export const mediamtxPath = (deliveryId: string) => `${deliveryId}/live`;

/** Which organisation's gateway a server is asked of. */
interface GatewayAt {
  organisationId: string;
  gatewayId: string;
}

/**
 * The URL of the protocol's server: the settings' override, or what the agent running the gateway registered, read by
 * trusted code. `gateway_unavailable` with neither, as while no agent runs it.
 */
async function serverUrl(request: GatewayAt, protocol: MediamtxProtocol, settings: MediamtxSettings) {
  const override = settings.urls[protocol];
  if (override !== undefined) return override;
  const registered = await trustedTransaction(() => registeredEndpointUrls(request.organisationId, request.gatewayId), {
    name: 'gateway.endpoints'
  });
  const url = registered.get(protocol);
  if (url === undefined) throw new ApiFailure('gateway_unavailable', { cause: `No ${protocol} server is registered` });
  return url;
}

/** Where to read or publish the path by the protocol, under its server's URL. */
function endpoint(protocol: MediamtxProtocol, base: string, path: string, action: ConnectionAction) {
  const root = base.endsWith('/') ? base : `${base}/`;
  switch (protocol) {
    case 'webrtc':
      return new URL(`${path}/${action === 'read' ? 'whep' : 'whip'}`, root).href;
    case 'hls':
      return new URL(`${path}/index.m3u8`, root).href;
    case 'rtsp':
    case 'rtsps':
    case 'rtmp':
    case 'rtmps':
      return new URL(path, root).href;
  }
}

/**
 * The identity of the agent running the gateway, which signs its tokens: the active agent on the gateway's network,
 * read by trusted code since its private key is hidden from request sessions. `gateway_unavailable` while no agent is
 * active there, since no one would be running the MediaMTX to admit the connection anyway.
 */
async function signingIdentity(organisationId: string, gatewayId: string) {
  const [agent] = await trustedTransaction(
    () => {
      const db = useDB({ trusted: true });
      return db
        .select({ publicId: devices.publicId, publicKey: devices.publicKey, privateKey: devices.privateKey })
        .from(gateways)
        .innerJoin(
          agents,
          and(eq(agents.organisationId, gateways.organisationId), eq(agents.networkId, gateways.networkId))
        )
        .innerJoin(devices, eq(devices.id, agents.id))
        .where(and(eq(gateways.organisationId, organisationId), eq(gateways.id, gatewayId), eq(agents.active, true)))
        .limit(1);
    },
    { name: 'gateway.signing_identity' }
  );
  if (agent === undefined) throw new ApiFailure('gateway_unavailable', { cause: 'No active agent runs this gateway' });
  const d = Buffer.from(agent.privateKey).toString('base64url');
  const key = await importJWK({ kty: 'OKP', crv: 'Ed25519', x: agent.publicKey, d }, GATEWAY_SIGNING_ALGORITHM);
  return { kid: agent.publicId, key };
}

/** A token admitting the action on the path at this gateway only, signed as the agent running it. */
async function mediamtxToken(request: ConnectionRequest, path: string, issuedAt: number, expiresAt: number) {
  const environment = useEnvironment();
  const { kid, key } = await signingIdentity(request.organisationId, request.gatewayId);
  return new SignJWT({ mediamtx_permissions: [{ action: request.action, path }] })
    .setProtectedHeader({ alg: GATEWAY_SIGNING_ALGORITHM, kid, typ: 'JWT' })
    .setIssuer(environment.variables.APP_URL)
    .setAudience(request.gatewayId)
    .setSubject(request.subject)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(key);
}

/**
 * Whether each delivery is live, by its paths' last reports: any one ready, by the last value reported of it. Read by
 * trusted code, for deliveries the caller has already seen; null for one with no report so recent.
 */
async function readyDeliveries(organisationId: string, deliveryIds: readonly string[]) {
  const subjectIds = deliveryIds.map(exposureSubject);
  const { name, unit } = pathMetrics.ready;
  const points = await trustedTransaction(
    () => latestPoints(organisationId, { subjectIds, name, unit, seconds: READY_REPORT_SECONDS }),
    { name: 'gateway.live' }
  );
  return Object.fromEntries(
    deliveryIds.map(deliveryId => {
      const paths = points.filter(point => point.subjectId === exposureSubject(deliveryId));
      return [deliveryId, paths.length === 0 ? null : paths.some(path => path.last >= 1)];
    })
  );
}

/**
 * The protocols an encoder is offered, in the order it is told of them: RTMP over TLS, plain RTMP (on site, where TLS
 * is not worth a failure), and WHIP. SRT is served by the agent's MediaMTX but no agent registers where (no
 * `MEDIAMTX_PROTOCOLS` entry), so it is not offered yet.
 */
const ENCODER_PROTOCOLS = ['rtmps', 'rtmp', 'webrtc'] as const satisfies readonly MediamtxProtocol[];

/**
 * What an encoder pastes to publish a path by its stream's key. RTMP reads its URL as an app and a stream name, which
 * MediaMTX joins into the path, and the stream name's query as the query MediaMTX hands its authentication (the
 * agent's, apps/agent/core/src/gateway/streams/auth.ts): so the server is `…/<delivery>`, the stream key
 * `live?key=<key>`, and an encoder that takes a whole URL is given both joined. WHIP takes its endpoint and a bearer
 * token, which is the key itself.
 */
function encoderServer(protocol: (typeof ENCODER_PROTOCOLS)[number], base: string, deliveryId: string, key: string) {
  const root = base.endsWith('/') ? base.slice(0, -1) : base;
  if (protocol === 'webrtc') {
    return { protocol, url: endpoint(protocol, root, mediamtxPath(deliveryId), 'publish'), bearerToken: key };
  }
  const server = `${root}/${deliveryId}`;
  const streamKey = `live?key=${encodeURIComponent(key)}`;
  return { protocol, url: `${server}/${streamKey}`, server, streamKey };
}

export const mediamtx = provider.organisation({
  name: 'MediaMTX',
  ingest: INGEST,
  egress: EGRESS,
  settings: MediamtxSettingsSchema,
  live: request => readyDeliveries(request.organisationId, request.deliveryIds),
  // Each protocol whose server is known, from the gateway's settings or what its agent registered: as `serverUrl` finds
  // one. None while no agent runs it and nothing is overridden.
  served: (registered, settings) => {
    const overridden = Object.keys(settings.urls);
    return new Set([...registered, ...overridden]);
  },
  // Each protocol whose server is known, from the gateway's settings or what its agent registered; none while no agent
  // runs it.
  encoder: async request => {
    const servers = [];
    for (const protocol of ENCODER_PROTOCOLS) {
      const base = await serverUrl(request, protocol, request.settings).catch(() => undefined);
      if (base !== undefined) servers.push(encoderServer(protocol, base, request.delivery.id, request.key));
    }
    return servers;
  },
  connect: async request => {
    const { protocol } = request;
    const base = await serverUrl(request, protocol, request.settings);
    const path = mediamtxPath(request.delivery.id);
    const url = endpoint(protocol, base, path, request.action);
    const environment = useEnvironment();
    const issuedAt = Math.floor(environment.clock() / 1000);
    const expiresAt = issuedAt + CONNECTION_LIFETIME_SECONDS;
    const token = await mediamtxToken(request, path, issuedAt, expiresAt);
    return { protocol, url, token, expiresAt: new Date(expiresAt * 1000).toISOString() };
  }
});
