import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';

// An ordinary unversioned operation: omit operationVersion from its description.
export default new Hono().get(
  '/health',
  describeRoute({
    operationId: 'health.get',
    summary: 'Health check',
    responses: { 200: { description: 'The server is ready' } }
  }),
  c => c.json({ status: 'ok' as const }, 200)
);
