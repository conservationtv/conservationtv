import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { publishedKeys } from '../gatekeeper/keys.ts';
import { useServices } from '../services.ts';

// Fetched by gatekeeper, not called through the SDK, so hidden from the published contract.
export default new Hono().get('/jwks.json', describeRoute({ hide: true }), c => {
  const services = useServices();
  const jwks = publishedKeys(services.config.GRANT_SIGNING_KEYS);
  // Gatekeeper keeps it fresh for this long, clamped to its own bounds, and refetches early on an unknown key.
  c.header('Cache-Control', 'public, max-age=300');
  return c.json(jwks, 200);
});
