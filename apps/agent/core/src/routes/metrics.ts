import {
  NotFoundError,
  errorResponse,
  operationVersion,
  validator,
  versionMismatch
} from '@conservationtv/versioned-api/server';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { getMetricSeries, listMetricPoints, listMetricSeries } from '../db/metrics.ts';

/** The most buckets one read of a series returns. */
const MAX_BUCKETS = 1000;

const invalidRequest = errorResponse('The request is malformed');
const notFound = errorResponse('The series does not exist');

const PointsQuerySchema = z
  .object({
    from: z.iso.datetime({ offset: true }).describe('Points observed at or after this time.'),
    to: z.iso.datetime({ offset: true }).optional().describe('Points observed before this time; now by default.'),
    step: z.coerce
      .number()
      .int()
      .min(1)
      .max(31 * 24 * 60 * 60)
      .optional()
      .describe(`Seconds per bucket, at least; widened so the range has at most ${MAX_BUCKETS} buckets.`)
  })
  .refine(({ from, to }) => to === undefined || Date.parse(from) < Date.parse(to), '`from` is before `to`.');
export type PointsQuery = z.output<typeof PointsQuerySchema>;

const SeriesQuerySchema = z.object({
  name: z.string().min(1).max(200).optional().describe('Only series of this metric.')
});
export type SeriesQuery = z.output<typeof SeriesQuerySchema>;

// The samples the agent's runtimes took, kept on its disk (src/db/metrics.ts): finer than the summaries the studio API
// gets, and for as long as the agent's retention allows.
export default new Hono()
  .get(
    '/',
    describeRoute({
      operationId: 'metrics.list',
      ...operationVersion(1),
      summary: 'List the metric series the agent keeps',
      description:
        'Each series is one metric about one subject, with one unit and set of dimensions, such as the ingest bitrate of one MediaMTX path, and the range of the points the agent still has. A series about the agent’s own device has a null `subjectId`. Optionally of one metric, by name. Read a series’ points with `metrics.get`.',
      responses: {
        200: { description: 'The series, by name' },
        400: invalidRequest,
        412: versionMismatch
      }
    }),
    validator('query', SeriesQuerySchema),
    c => {
      const filter = c.req.valid('query');
      const series = listMetricSeries(filter);
      c.header('Cache-Control', 'no-store');
      return c.json({ series }, 200);
    }
  )
  .get(
    '/:seriesId',
    describeRoute({
      operationId: 'metrics.get',
      ...operationVersion(1),
      summary: 'Read a metric series over a time range',
      description: `The series, and its points from \`from\` until \`to\` in buckets of \`step\` seconds, oldest first: each bucket's least and greatest samples, their mean, the last and how many there were. A bucket with no points is absent, so a gap is a time nothing was sampled. The step defaults to the samples' own, 10 seconds, and is widened so the range has at most ${MAX_BUCKETS} buckets, and returned.`,
      responses: {
        200: { description: 'The series and its points' },
        400: invalidRequest,
        404: notFound,
        412: versionMismatch
      }
    }),
    validator('param', z.object({ seriesId: z.coerce.number().int().positive().describe('The series.') })),
    validator('query', PointsQuerySchema),
    c => {
      const { seriesId } = c.req.valid('param');
      const query = c.req.valid('query');
      const from = new Date(query.from);
      const to = query.to === undefined ? new Date() : new Date(query.to);
      const range = Math.ceil((to.getTime() - from.getTime()) / 1000);
      const step = Math.max(query.step ?? 10, Math.ceil(range / MAX_BUCKETS));
      const series = getMetricSeries(seriesId);
      if (series === undefined) throw new NotFoundError('The series does not exist');
      const points = listMetricPoints(seriesId, { from, to, step });
      c.header('Cache-Control', 'no-store');
      return c.json({ ...series, from, to, step, points }, 200);
    }
  );
