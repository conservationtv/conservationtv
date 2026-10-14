import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { MAX_ASSERTION_LENGTH } from '../grants/assertion.ts';
import { exchangeGrant } from '../grants/exchange.ts';
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
    summary: 'Exchange a grant assertion',
    description:
      'Exchanges a consumer-signed `relay-grant+jwt` assertion for relay credentials: a MoQ capability token and/or an ' +
      'Iroh endpoint lease. Every security-relevant field lives inside the signed assertion; each assertion can be ' +
      'exchanged once. Responses are secrets and are never cacheable.',
    responses: {
      200: { description: 'The issued relay credentials' },
      400: invalidRequest,
      401: unauthorized,
      403: forbidden,
      412: versionMismatch,
      503: unavailable
    }
  }),
  strictJsonBody,
  validator(
    'json',
    z.strictObject({
      grant_assertion: z
        .string()
        .min(1)
        .max(MAX_ASSERTION_LENGTH)
        .describe('A compact JWS grant assertion signed by the consumer, with `typ: relay-grant+jwt`.')
    })
  ),
  async c => {
    const { grant_assertion } = c.req.valid('json');
    const result = await exchangeGrant(grant_assertion);
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(result, 200);
  }
);
