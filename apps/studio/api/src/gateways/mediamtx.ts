import { SignJWT } from 'jose';
import { z } from 'zod';
import { ApiFailure } from '../errors.ts';
import { useEnvironment } from '../env/env.ts';
import { CONNECTION_LIFETIME_SECONDS, provider, type ConnectionAction, type ConnectionRequest } from './provider.ts';
import { GATEWAY_SIGNING_ALGORITHM } from './keys.ts';

// MediaMTX gateways admit connections by JWTs this API signs (src/gateways/keys.ts), which MediaMTX verifies itself
// against the published JWKS. Each MediaMTX gateway is configured with:
//
//   authMethod: jwt
//   authJWTJWKS: <APP_URL>/gateway-keys
//   authJWTIssuer: <APP_URL>
//   authJWTAudience: <the gateway's ID>
//
// so a token admits one action on one path, at only the gateway it was issued for. The gateway's settings say where
// each of its protocols' servers listens, as its network reaches them.

const MEDIAMTX_PROTOCOLS = ['webrtc', 'rtsp', 'rtsps', 'rtmp', 'rtmps', 'hls'] as const;
type MediamtxProtocol = (typeof MEDIAMTX_PROTOCOLS)[number];

/** Where each of the gateway's protocols' servers listens, as its network reaches them. */
const MediamtxSettingsSchema = z.strictObject({ urls: z.partialRecord(z.enum(MEDIAMTX_PROTOCOLS), z.url()) });
type MediamtxSettings = z.output<typeof MediamtxSettingsSchema>;

/** The MediaMTX path an exposure is served at: the configuration builders name it the same. */
export const mediamtxPath = (exposureId: string) => exposureId;

/** Where to read or publish the path by the protocol, under its server's URL; `undefined` where MediaMTX cannot. */
function endpoint(protocol: MediamtxProtocol, base: string, path: string, action: ConnectionAction) {
  const root = base.endsWith('/') ? base : `${base}/`;
  switch (protocol) {
    case 'webrtc':
      return new URL(`${path}/${action === 'read' ? 'whep' : 'whip'}`, root).href;
    case 'hls':
      return action === 'read' ? new URL(`${path}/index.m3u8`, root).href : undefined;
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
  protocols: MEDIAMTX_PROTOCOLS,
  settings: MediamtxSettingsSchema,
  connect: async request => {
    const { protocol } = request.exposure;
    const urls: MediamtxSettings['urls'] = request.settings.urls;
    const base = urls[protocol];
    if (base === undefined) throw new ApiFailure('gateway_unavailable', { cause: `No ${protocol} URL is configured` });
    const path = mediamtxPath(request.exposure.id);
    const url = endpoint(protocol, base, path, request.action);
    if (url === undefined) throw new ApiFailure('unsupported_action');
    const environment = useEnvironment();
    const issuedAt = Math.floor(environment.clock() / 1000);
    const expiresAt = issuedAt + CONNECTION_LIFETIME_SECONDS;
    const token = await mediamtxToken(request, path, issuedAt, expiresAt);
    return { protocol, url, token, expiresAt: new Date(expiresAt * 1000).toISOString() };
  }
});
