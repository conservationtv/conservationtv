import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import {
  logRecords,
  metricSamples,
  metricSeries,
  observations,
  reporterOpinions,
  subjectStates
} from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { requirePrincipal, usePrincipal } from '../middleware/principal.ts';
import { SubjectIdSchema } from '../reports/subjects.ts';
import { useServices } from '../services.ts';
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
const SeriesParamsSchema = SubjectParamsSchema.extend({ seriesId: z.uuid().describe('The metric series.') });
export type SeriesParams = z.output<typeof SeriesParamsSchema>;

const HistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100).describe('At most this many, newest first.'),
  before: z.iso.datetime({ offset: true }).optional().describe('Only those observed before this time, to page back.')
});
export type HistoryQuery = z.output<typeof HistoryQuerySchema>;

// What agents report about a subject, in the principal's request session: members read it all. A subject is a string
// (src/reports/subjects.ts), so there is nothing to create or delete, and one nothing was reported about reads as empty.
// Reports themselves are only ever written by signed ingestion (/reports), and opinions and subject state by the state
// consumer. Freshness is evaluated by Postgres against each expiry when read, so state
// goes stale without a new report.
export default new Hono()
  .get(
    '/:id/subjects/:subjectId/state',
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
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const { state, opinions } = await session.transaction(async tx => {
        const [combined] = await tx
          .select({
            health: subjectStates.health,
            state: subjectStates.state,
            freshness: sql<
              'fresh' | 'stale'
            >`case when ${subjectStates.expiresAt} > now() then 'fresh' else 'stale' end`,
            observedAt: subjectStates.observedAt,
            expiresAt: subjectStates.expiresAt,
            computedAt: subjectStates.computedAt,
            contributingReporterIds: subjectStates.contributingReporterIds,
            evidenceReportIds: subjectStates.evidenceReportIds
          })
          .from(subjectStates)
          .where(and(eq(subjectStates.organisationId, id), eq(subjectStates.subjectId, subjectId)));
        return {
          state: combined ?? null,
          opinions: await tx
            .select({
              reporterId: reporterOpinions.reporterId,
              health: reporterOpinions.health,
              state: reporterOpinions.state,
              freshness: sql<
                'fresh' | 'stale'
              >`case when ${reporterOpinions.expiresAt} > now() then 'fresh' else 'stale' end`,
              observedAt: reporterOpinions.observedAt,
              expiresAt: reporterOpinions.expiresAt,
              evidenceReportIds: reporterOpinions.evidenceReportIds
            })
            .from(reporterOpinions)
            .where(and(eq(reporterOpinions.organisationId, id), eq(reporterOpinions.subjectId, subjectId)))
            .orderBy(reporterOpinions.reporterId)
        };
      });
      c.header('Cache-Control', 'no-store');
      return c.json({ subjectId, state, reachable: state?.freshness === 'fresh', opinions }, 200);
    }
  )
  .get(
    '/:id/subjects/:subjectId/observations',
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
      const { limit, before } = c.req.valid('query');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const rows = await session.transaction(tx =>
        tx
          .select({
            id: observations.id,
            reporterId: observations.reporterId,
            keyId: observations.keyId,
            observedAt: observations.observedAt,
            receivedAt: observations.receivedAt,
            type: observations.type,
            data: observations.data
          })
          .from(observations)
          .where(
            and(
              eq(observations.organisationId, id),
              eq(observations.subjectId, subjectId),
              before === undefined ? undefined : lt(observations.observedAt, new Date(before))
            )
          )
          .orderBy(desc(observations.observedAt))
          .limit(limit)
      );
      c.header('Cache-Control', 'no-store');
      return c.json({ observations: rows }, 200);
    }
  )
  .get(
    '/:id/subjects/:subjectId/metrics',
    describeRoute({
      operationId: 'organisations.subjects.metrics.list',
      ...operationVersion(1),
      summary: "List a subject's metric series",
      description:
        'One series per reporter, metric name and dimensions: two reporters measuring the same quantity are two series, never summed.',
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
    async c => {
      const { id, subjectId } = c.req.valid('param');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const rows = await session.transaction(tx =>
        tx
          .select({
            id: metricSeries.id,
            reporterId: metricSeries.reporterId,
            name: metricSeries.name,
            type: metricSeries.type,
            unit: metricSeries.unit,
            dimensions: metricSeries.dimensions
          })
          .from(metricSeries)
          .where(and(eq(metricSeries.organisationId, id), eq(metricSeries.subjectId, subjectId)))
          .orderBy(metricSeries.name, metricSeries.id)
      );
      c.header('Cache-Control', 'no-store');
      return c.json({ series: rows }, 200);
    }
  )
  .get(
    '/:id/subjects/:subjectId/metrics/:seriesId/samples',
    describeRoute({
      operationId: 'organisations.subjects.metrics.samples',
      ...operationVersion(1),
      summary: "List a metric series' samples",
      description: 'Newest observation first.',
      responses: {
        200: { description: 'The samples' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', SeriesParamsSchema),
    validator('query', HistoryQuerySchema),
    async c => {
      const { id, subjectId, seriesId } = c.req.valid('param');
      const { limit, before } = c.req.valid('query');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const rows = await session.transaction(async tx => {
        const [series] = await tx
          .select({ id: metricSeries.id })
          .from(metricSeries)
          .where(
            and(
              eq(metricSeries.organisationId, id),
              eq(metricSeries.subjectId, subjectId),
              eq(metricSeries.id, seriesId)
            )
          );
        if (!series) throw new ApiFailure('not_found');
        return tx
          .select({
            reportId: metricSamples.reportId,
            observedAt: metricSamples.observedAt,
            receivedAt: metricSamples.receivedAt,
            value: metricSamples.value
          })
          .from(metricSamples)
          .where(
            and(
              eq(metricSamples.seriesId, seriesId),
              before === undefined ? undefined : lt(metricSamples.observedAt, new Date(before))
            )
          )
          .orderBy(desc(metricSamples.observedAt))
          .limit(limit);
      });
      c.header('Cache-Control', 'no-store');
      return c.json({ samples: rows }, 200);
    }
  )
  .get(
    '/:id/subjects/:subjectId/logs',
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
      const { limit, before } = c.req.valid('query');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const rows = await session.transaction(tx =>
        tx
          .select({
            id: logRecords.id,
            reporterId: logRecords.reporterId,
            keyId: logRecords.keyId,
            observedAt: logRecords.observedAt,
            receivedAt: logRecords.receivedAt,
            level: logRecords.level,
            message: logRecords.message,
            context: logRecords.context
          })
          .from(logRecords)
          .where(
            and(
              eq(logRecords.organisationId, id),
              eq(logRecords.subjectId, subjectId),
              before === undefined ? undefined : lt(logRecords.observedAt, new Date(before))
            )
          )
          .orderBy(desc(logRecords.observedAt))
          .limit(limit)
      );
      c.header('Cache-Control', 'no-store');
      return c.json({ logs: rows }, 200);
    }
  );
