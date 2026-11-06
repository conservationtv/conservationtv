import { SUBJECT_KINDS, SubjectIdSchema } from '@conservationtv/reports';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { ApiFailure } from '../errors.ts';
import { transaction } from '../db/transaction.ts';
import { useEnvironment } from '../env/env.ts';
import { requirePrincipal } from '../middleware/principal.ts';
import {
  getMetricSeries,
  getSubjectState,
  listLogs,
  listMetricPoints,
  listMetricSeries,
  listObservations,
  listReporterOpinions,
  listSubjectStates,
  queryMetrics
} from '../services/subjects.ts';
import {
  invalidRequest,
  notFound,
  operationVersion,
  unauthenticated,
  unavailable,
  validator,
  versionMismatch
} from './openapi.ts';

const OrganisationParamsSchema = z.object({ id: z.uuid().describe('The organisation.') });
export type OrganisationParams = z.output<typeof OrganisationParamsSchema>;
const SubjectParamsSchema = OrganisationParamsSchema.extend({ subjectId: SubjectIdSchema });
export type SubjectParams = z.output<typeof SubjectParamsSchema>;

const HistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100).describe('At most this many, newest first.'),
  before: z.iso.datetime({ offset: true }).optional().describe('Only those observed before this time, to page back.')
});
export type HistoryQuery = z.output<typeof HistoryQuerySchema>;

const SeriesParamsSchema = SubjectParamsSchema.extend({ seriesId: z.uuid().describe('The series.') });
export type SeriesParams = z.output<typeof SeriesParamsSchema>;

/** The most buckets one read of a series returns. */
const MAX_BUCKETS = 1000;

const rangeFields = {
  from: z.iso.datetime({ offset: true }).describe('Points observed at or after this time.'),
  to: z.iso.datetime({ offset: true }).optional().describe('Points observed before this time; now by default.'),
  step: z.coerce
    .number()
    .int()
    .min(10)
    .max(31 * 24 * 60 * 60)
    .optional()
    .describe(`Seconds per bucket, at least; widened so the range has at most ${MAX_BUCKETS} buckets.`)
};
/** A requested range: from, and optionally until. */
interface RequestedRange {
  from: string;
  to?: string;
}
const rangeInOrder = ({ from, to }: RequestedRange) => to === undefined || Date.parse(from) < Date.parse(to);
const PointsQuerySchema = z.object(rangeFields).refine(rangeInOrder, '`from` is before `to`.');
export type PointsQuery = z.output<typeof PointsQuerySchema>;

/** The most subjects, and metrics, one query across subjects reads. */
const MAX_QUERIED_SUBJECTS = 100;
const MAX_QUERIED_METRICS = 20;

const MetricQuerySchema = z
  .strictObject({
    subjectIds: z
      .array(SubjectIdSchema)
      .min(1)
      .max(MAX_QUERIED_SUBJECTS)
      .describe('Series about any of these subjects.'),
    names: z
      .array(z.string().min(1).max(200))
      .min(1)
      .max(MAX_QUERIED_METRICS)
      .describe('Series of any of these metrics.'),
    ...rangeFields
  })
  .refine(rangeInOrder, '`from` is before `to`.');
export type MetricQuery = z.output<typeof MetricQuerySchema>;

/** A read's range, its step widened so the range has at most MAX_BUCKETS buckets. */
function bucketRangeOf(query: PointsQuery) {
  const environment = useEnvironment();
  const from = new Date(query.from);
  const to = query.to === undefined ? new Date(environment.clock()) : new Date(query.to);
  const range = Math.ceil((to.getTime() - from.getTime()) / 1000);
  const step = Math.max(query.step ?? 60, Math.ceil(range / MAX_BUCKETS));
  return { from, to, step };
}

// What devices report about a subject, in the principal's request session: members read it all (src/services/subjects.ts).
// A subject is a string, so there is nothing to create or delete. Reports themselves are only ever written by signed
// ingestion (/reports), and opinions and subject state by the state consumer.
const SubjectKindSchema = z
  .enum([...SUBJECT_KINDS, 'external'])
  .describe('Only subjects of this kind: the part of their ID before the colon.');
export type SubjectKind = z.output<typeof SubjectKindSchema>;

export default new Hono()
  .get(
    '/states',
    describeRoute({
      operationId: 'organisations.subjects.states.list',
      ...operationVersion(1),
      summary: "List the organisation's subjects' current states",
      description:
        "Every subject's combined state, as the state consumer last derived it, each with its freshness evaluated now: a stale subject is unreachable, and keeps the health last observed. Optionally only subjects of one kind. Subjects the consumer has derived no state for are absent. Read one subject with `organisations.subjects.state` for its reporters' opinions.",
      responses: {
        200: { description: 'The states, by subject ID' },
        400: invalidRequest,
        401: unauthenticated,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    validator('query', z.object({ kind: SubjectKindSchema.optional() })),
    async c => {
      const { id } = c.req.valid('param');
      const filter = c.req.valid('query');
      const rows = await transaction(() => listSubjectStates(id, filter));
      c.header('Cache-Control', 'no-store');
      return c.json({ states: rows }, 200);
    }
  )
  .post(
    '/metrics/query',
    describeRoute({
      operationId: 'organisations.subjects.metrics.query',
      ...operationVersion(1),
      summary: 'Read metric series across subjects over a time range',
      description: `Every series of any of \`names\` about any of \`subjectIds\`, by subject, then name, each with its points from \`from\` until \`to\` bucketed as \`organisations.subjects.metrics.get\` buckets them. Subjects and metrics nothing was reported about are absent. At most ${MAX_QUERIED_SUBJECTS} subjects and ${MAX_QUERIED_METRICS} metrics; the step is widened so the range has at most ${MAX_BUCKETS} buckets, and returned.`,
      responses: {
        200: { description: 'The range, and the series with their points' },
        400: invalidRequest,
        401: unauthenticated,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    validator('json', MetricQuerySchema),
    async c => {
      const { id } = c.req.valid('param');
      const { subjectIds, names, ...query } = c.req.valid('json');
      const range = bucketRangeOf(query);
      const series = await transaction(() => queryMetrics(id, { subjectIds, names }, range));
      c.header('Cache-Control', 'no-store');
      return c.json({ ...range, series }, 200);
    }
  )
  .get(
    '/:subjectId/state',
    describeRoute({
      operationId: 'organisations.subjects.state',
      ...operationVersion(1),
      summary: "Read a subject's current state",
      description:
        "The combined state and each reporter's opinion beneath it, as the state consumer last derived them, each with its freshness evaluated now. A stale subject is unreachable, and keeps the health last observed rather than becoming unhealthy. `state` is null until the consumer has derived one.",
      responses: {
        200: { description: 'The state, with opinions oldest reporter first' },
        400: invalidRequest,
        401: unauthenticated,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', SubjectParamsSchema),
    async c => {
      const { id, subjectId } = c.req.valid('param');
      const { state, opinions } = await transaction(async () => {
        const combined = await getSubjectState(id, subjectId);
        const reporters = await listReporterOpinions(id, subjectId);
        return { state: combined ?? null, opinions: reporters };
      });
      c.header('Cache-Control', 'no-store');
      return c.json({ subjectId, state, reachable: state?.freshness === 'fresh', opinions }, 200);
    }
  )
  .get(
    '/:subjectId/observations',
    describeRoute({
      operationId: 'organisations.subjects.observations.list',
      ...operationVersion(1),
      summary: 'List the events reported about a subject',
      description: 'Every reporter’s accepted event reports, newest observation first.',
      responses: {
        200: { description: 'The observations' },
        400: invalidRequest,
        401: unauthenticated,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', SubjectParamsSchema),
    validator('query', HistoryQuerySchema),
    async c => {
      const { id, subjectId } = c.req.valid('param');
      const page = c.req.valid('query');
      const rows = await transaction(() => listObservations(id, subjectId, page));
      c.header('Cache-Control', 'no-store');
      return c.json({ observations: rows }, 200);
    }
  )
  .get(
    '/:subjectId/metrics',
    describeRoute({
      operationId: 'organisations.subjects.metrics.list',
      ...operationVersion(1),
      summary: 'List the metric series reported about a subject',
      description:
        'Each series is one metric from one reporter, with one unit and set of dimensions, such as the bitrate of one MediaMTX path. Optionally of one metric, by name. Read a series’ points with `organisations.subjects.metrics.get`.',
      responses: {
        200: { description: 'The series, by name' },
        400: invalidRequest,
        401: unauthenticated,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', SubjectParamsSchema),
    validator(
      'query',
      z.object({ name: z.string().min(1).max(200).optional().describe('Only series of this metric.') })
    ),
    async c => {
      const { id, subjectId } = c.req.valid('param');
      const filter = c.req.valid('query');
      const rows = await transaction(() => listMetricSeries(id, subjectId, filter));
      c.header('Cache-Control', 'no-store');
      return c.json({ series: rows }, 200);
    }
  )
  .get(
    '/:subjectId/metrics/:seriesId',
    describeRoute({
      operationId: 'organisations.subjects.metrics.get',
      ...operationVersion(1),
      summary: 'Read a metric series over a time range',
      description: `The series, and its points from \`from\` until \`to\` in buckets of \`step\` seconds, oldest first: each bucket's least and greatest values, the mean weighted by samples, the last value and how many samples it summarises. A bucket with no points is absent, so a gap is a time the reporter reported nothing. The step is widened so the range has at most ${MAX_BUCKETS} buckets, and returned.`,
      responses: {
        200: { description: 'The series and its points' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', SeriesParamsSchema),
    validator('query', PointsQuerySchema),
    async c => {
      const { id, subjectId, seriesId } = c.req.valid('param');
      const query = c.req.valid('query');
      const { from, to, step } = bucketRangeOf(query);
      const result = await transaction(async () => {
        const series = await getMetricSeries(id, subjectId, seriesId);
        if (!series) throw new ApiFailure('not_found');
        const points = await listMetricPoints(id, seriesId, { from, to, step });
        return { ...series, from, to, step, points };
      });
      c.header('Cache-Control', 'no-store');
      return c.json(result, 200);
    }
  )
  .get(
    '/:subjectId/logs',
    describeRoute({
      operationId: 'organisations.subjects.logs.list',
      ...operationVersion(1),
      summary: 'List the logs reported about a subject',
      description: 'Every reporter’s accepted log reports, newest observation first.',
      responses: {
        200: { description: 'The log records' },
        400: invalidRequest,
        401: unauthenticated,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', SubjectParamsSchema),
    validator('query', HistoryQuerySchema),
    async c => {
      const { id, subjectId } = c.req.valid('param');
      const page = c.req.valid('query');
      const rows = await transaction(() => listLogs(id, subjectId, page));
      c.header('Cache-Control', 'no-store');
      return c.json({ logs: rows }, 200);
    }
  );
