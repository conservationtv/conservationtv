import { errorResponse, operationVersion, validator, versionMismatch } from '@conservationtv/versioned-api/server';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { LOG_LEVELS, listLogs } from '../db/logs.ts';

const invalidRequest = errorResponse('The request is malformed');

const LogsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100).describe('At most this many, newest first.'),
  before: z.coerce.number().int().positive().optional().describe('Only lines before this one, by id, to page back.'),
  level: z.enum(LOG_LEVELS).optional().describe('Only lines at least this severe.'),
  category: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Only lines from this logger category or those beneath it, such as `agent.mediamtx`.')
});
export type LogsQuery = z.output<typeof LogsQuerySchema>;

// The agent's logs, kept on its disk (src/db/logs.ts) for as long as its retention allows. Never shipped to the studio.
export default new Hono().get(
  '/',
  describeRoute({
    operationId: 'logs.list',
    ...operationVersion(1),
    summary: "List the agent's logs",
    description:
      'Each line the agent logged, newest first: its message with values substituted, the template it was made from, and its values as properties. Page back by passing the last id as `before`.',
    responses: {
      200: { description: 'The log lines' },
      400: invalidRequest,
      412: versionMismatch
    }
  }),
  validator('query', LogsQuerySchema),
  c => {
    const query = c.req.valid('query');
    const logs = listLogs(query);
    c.header('Cache-Control', 'no-store');
    return c.json({ logs }, 200);
  }
);
