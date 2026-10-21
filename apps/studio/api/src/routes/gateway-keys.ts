import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { useEnvironment } from '../env/env.ts';
import { operationVersion, versionMismatch } from './openapi.ts';

// The public keys gateway tokens are signed with (src/gateways/keys.ts), for the gateways that verify them, such as
// MediaMTX's `authJWTJWKS`. Gateways fetch it with no session and no `Operation-Version`, so the latest is served.
export default new Hono().get(
  '/',
  describeRoute({
    operationId: 'gatewayKeys.get',
    ...operationVersion(1),
    summary: 'Read the gateway signing keys',
    description:
      'A JSON Web Key Set of every key gateway tokens may be signed with: a gateway verifies a token by the key its `kid` names, with issuer the API and audience the gateway’s ID. Empty when no gateway tokens are signed. Anyone.',
    responses: {
      200: { description: 'The key set' },
      412: versionMismatch
    }
  }),
  async c => {
    const environment = useEnvironment();
    const keyring = await environment.gatewayKeys?.keyring();
    c.header('Cache-Control', 'public, max-age=300');
    return c.json({ keys: keyring?.publicKeys ?? [] }, 200);
  }
);
