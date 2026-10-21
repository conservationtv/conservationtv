import { SignJWT } from 'jose';
import { z } from 'zod';
import { ApiFailure } from '../errors.ts';
import { useEnvironment } from '../env/env.ts';
import type { Rendition } from '../topology/settings.ts';
import { CONNECTION_LIFETIME_SECONDS, provider, type ConnectionAction, type ConnectionRequest } from './provider.ts';
import { GATEWAY_SIGNING_ALGORITHM } from './keys.ts';

// MediaMTX gateways admit connections by JWTs this API signs (src/gateways/keys.ts), verified against the published
// JWKS (`<APP_URL>/gateway-keys`), issued by `<APP_URL>`, for the gateway's ID as their audience: a token admits one
// action on one path, at only the gateway it was issued for. An agent running the gateway checks them for its MediaMTX
// (apps/agent/core/src/runtimes/mediamtx/auth.ts), which also admits readers on the agent's own machine without one.
// A MediaMTX run any other way can check them itself (`authMethod: jwt`). The gateway's settings say where
// each of its protocols' servers listens, as its network reaches them.

const MEDIAMTX_PROTOCOLS = ['webrtc', 'rtsp', 'rtsps', 'rtmp', 'rtmps', 'hls'] as const;
type MediamtxProtocol = (typeof MEDIAMTX_PROTOCOLS)[number];

// Every MediaMTX protocol carries one path per connection, so each rendition is a path of its own. HLS serves each
// path's playlist on its own, with no master playlist across paths.
const INGEST = { webrtc: 'paths', rtsp: 'paths', rtsps: 'paths', rtmp: 'paths', rtmps: 'paths' } as const;
const EGRESS = { ...INGEST, hls: 'paths' } as const;

/** Where each of the gateway's protocols' servers listens, as its network reaches them. */
const MediamtxSettingsSchema = z.strictObject({ urls: z.partialRecord(z.enum(MEDIAMTX_PROTOCOLS), z.url()) });
export type MediamtxSettings = z.output<typeof MediamtxSettingsSchema>;

/** The MediaMTX path an exposure's rendition is served at: the configuration builders name it the same. */
export const mediamtxPath = (exposureId: string, rendition: Rendition) => `${exposureId}/${rendition}`;

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

/** A token admitting the action on the path at this gateway only. */
async function mediamtxToken(request: ConnectionRequest, path: string, issuedAt: number, expiresAt: number) {
  const environment = useEnvironment();
  const keyring = await environment.gatewayKeys?.();
  if (keyring === undefined) throw new ApiFailure('gateway_unavailable', { cause: 'GATEWAY_SIGNING_KEYS is unset' });
  return new SignJWT({ mediamtx_permissions: [{ action: request.action, path }] })
    .setProtectedHeader({ alg: GATEWAY_SIGNING_ALGORITHM, kid: keyring.activeKeyId, typ: 'JWT' })
    .setIssuer(environment.variables.APP_URL)
    .setAudience(request.gatewayId)
    .setSubject(request.subject)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(keyring.signingKey);
}

export const mediamtx = provider.organisation({
  name: 'MediaMTX',
  ingest: INGEST,
  egress: EGRESS,
  settings: MediamtxSettingsSchema,
  connect: async request => {
    const { protocol } = request;
    const { urls } = request.settings;
    const base = urls[protocol];
    if (base === undefined) throw new ApiFailure('gateway_unavailable', { cause: `No ${protocol} URL is configured` });
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
