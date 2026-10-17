import { base64url, type JWTPayload } from 'jose';

export const randomEndpointId = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');

/** A grant asking for both capabilities, with a fresh endpoint. */
export function exampleGrant(endpointId = randomEndpointId()) {
  const subscribe: string[] = [];
  return {
    subject: 'app-a:user:opaque-8f83d2',
    requested_capabilities: {
      moq: { root: 'app-a/t_92/room_71', publish: ['camera'], subscribe },
      iroh: { endpoint_id: endpointId, action: 'connect' as const }
    },
    expires_in: 300
  };
}
export type ExampleGrant = ReturnType<typeof exampleGrant>;

export function decodePayload(token: string): JWTPayload {
  const [, payload = ''] = token.split('.');
  return JSON.parse(new TextDecoder().decode(base64url.decode(payload)));
}
