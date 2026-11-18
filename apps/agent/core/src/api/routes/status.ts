import { versionMismatch, operationVersion } from '@conservationtv/versioned-api/server';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';

export default new Hono().get(
  '/',
  describeRoute({
    operationId: 'status.get',
    ...operationVersion(1),
    summary: 'Read the agent status',
    description: 'Whether the agent is up and serving requests.',
    responses: {
      200: { description: 'The agent is serving requests' },
      412: versionMismatch
    }
  }),
  c => {
    c.header('Cache-Control', 'no-store');
    return c.json({ status: 'ok' as const }, 200);
  }
);
