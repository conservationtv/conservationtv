import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { exchangeGrant } from '../grants/exchange.ts';
import { GrantSchema } from '../grants/grant.ts';
import { requireConsumer } from '../middleware/consumer.ts';
import {
  forbidden,
  invalidRequest,
  operationVersion,
  strictJsonBody,
  unauthorized,
  unavailable,
  validator,
  versionMismatch
} from './openapi.ts';

// Versions belong to individual operations. Keep their declarations together.
export default new Hono().post(
  '/exchange',
  describeRoute({
    operationId: 'grants.exchange',
    ...operationVersion(1),
    summary: 'Exchange a grant',
    description:
      'Exchanges a grant for relay credentials: a MoQ capability token and/or an Iroh endpoint lease. Requires the ' +
      "environment's consumer token as `Authorization: Bearer …`. Responses are secrets and are never cacheable.",
    responses: {
      200: { description: 'The issued relay credentials' },
      400: invalidRequest,
      401: unauthorized,
      403: forbidden,
      412: versionMismatch,
      503: unavailable
    }
  }),
  requireConsumer,
  strictJsonBody,
  validator('json', GrantSchema),
  async c => {
    const result = await exchangeGrant(c.req.valid('json'));
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(result, 200);
  }
);
