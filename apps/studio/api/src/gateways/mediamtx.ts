import { and, eq } from 'drizzle-orm';
import { importJWK, SignJWT } from 'jose';
import { z } from 'zod';
import { agents, devices, gateways } from '../db/schema.ts';
import { trustedTransaction, useDB } from '../db/transaction.ts';
import { ApiFailure } from '../errors.ts';
import { useEnvironment } from '../env/env.ts';
import { registeredEndpointUrls } from '../services/gateway-endpoints.ts';
import type { Rendition } from '../topology/settings.ts';
import { MEDIAMTX_PROTOCOLS, type MediamtxProtocol } from './mediamtx-protocols.ts';
import { CONNECTION_LIFETIME_SECONDS, provider, type ConnectionAction, type ConnectionRequest } from './provider.ts';

// MediaMTX gateways admit connections by JWTs this API signs with the identity of the agent running the gateway: the
// network's active agent's own Ed25519 key, which this API holds (src/topology/identity.ts) and the agent verifies
// against on its own (apps/agent/core/src/runtimes/mediamtx/auth.ts), with nothing to fetch from here. A token is
// issued by `<APP_URL>`, for the gateway's ID as its audience, and admits one action on one path, at only the gateway
// it was issued for. The agent also admits readers on its own machine without one. A MediaMTX run any other way can
// check them itself (`authMethod: jwt`) against the JWKS the agent serves.
//
// Where each of its protocols' servers listens is what the agent running it registered (src/services/gateway-endpoints.ts)
// from what its MediaMTX actually listens on. The gateway's settings may override a protocol's, for a reverse proxy in
// front of it, say.

/** How gateway tokens are signed: by the agent's Ed25519 identity, as JOSE names it. */
const GATEWAY_SIGNING_ALGORITHM = 'EdDSA';

// Every MediaMTX protocol carries one path per connection, so each rendition is a path of its own. HLS serves each
// path's playlist on its own, with no master playlist across paths.
const INGEST = { webrtc: 'paths', rtsp: 'paths', rtsps: 'paths', rtmp: 'paths', rtmps: 'paths' } as const;
const EGRESS = { ...INGEST, hls: 'paths' } as const;

/**
 * Where the gateway's protocols' servers listen, as its network reaches them, in place of what the agent running it
 * registered: none, to use those.
 */
const MediamtxSettingsSchema = z.strictObject({
  urls: z.partialRecord(z.enum(MEDIAMTX_PROTOCOLS), z.url()).default({})
});
export type MediamtxSettings = z.output<typeof MediamtxSettingsSchema>;

/** The MediaMTX path an exposure's rendition is served at: the configuration builders name it the same. */
export const mediamtxPath = (exposureId: string, rendition: Rendition) => `${exposureId}/${rendition}`;

/**
 * The URL of the protocol's server: the settings' override, or what the agent running the gateway registered, read by
 * trusted code. `gateway_unavailable` with neither, as while no agent runs it.
 */
async function serverUrl(request: ConnectionRequest, protocol: MediamtxProtocol, settings: MediamtxSettings) {
  const override = settings.urls[protocol];
  if (override !== undefined) return override;
  const registered = await trustedTransaction(() => registeredEndpointUrls(request.organisationId, request.gatewayId));
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
  const [agent] = await trustedTransaction(() => {
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
  });
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

export const mediamtx = provider.organisation({
  name: 'MediaMTX',
  ingest: INGEST,
  egress: EGRESS,
  settings: MediamtxSettingsSchema,
  connect: async request => {
    const { protocol } = request;
    const base = await serverUrl(request, protocol, request.settings);
    // Every MediaMTX protocol carries `paths`, so the request always names its rendition.
    const path = mediamtxPath(request.exposure.id, request.rendition!);
    const url = endpoint(protocol, base, path, request.action);
    const environment = useEnvironment();
    const issuedAt = Math.floor(environment.clock() / 1000);
    const expiresAt = issuedAt + CONNECTION_LIFETIME_SECONDS;
    const token = await mediamtxToken(request, path, issuedAt, expiresAt);
    return { protocol, url, token, expiresAt: new Date(expiresAt * 1000).toISOString() };
  }
});
