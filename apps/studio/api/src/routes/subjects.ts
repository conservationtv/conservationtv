import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { subjects } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { requirePrincipal, usePrincipal } from '../middleware/principal.ts';
import { useServices } from '../services.ts';
import { unchanged } from '../topology/transaction.ts';
import {
  forbidden,
  inUse,
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
const SubjectParamsSchema = OrganisationParamsSchema.extend({ subjectId: z.uuid().describe('The subject.') });
export type SubjectParams = z.output<typeof SubjectParamsSchema>;

/** The kinds of the topology entities' own subjects, created and labelled with their entities. */
const TOPOLOGY_KINDS = new Set(['network', 'device', 'agent', 'stream', 'exposure']);

const SubjectLabelSchema = z.string().trim().min(1).max(120).nullable().describe('A display label, never an identity.');
export type SubjectLabel = z.output<typeof SubjectLabelSchema>;

// Subjects: the stable identities that what agents observe will be attributed to. Each topology entity gets its own
// when it is created; administrators add external ones, such as websites. In the principal's request session: members
// read them, administrators manage them.
export default new Hono()
  .get(
    '/:id/subjects',
    describeRoute({
      operationId: 'organisations.subjects.list',
      ...operationVersion(1),
      summary: "List an organisation's subjects",
      description:
        'The topology entities’ subjects and any external targets, optionally of one kind. Empty for organisations you are not a member of.',
      responses: {
        200: { description: 'The subjects, oldest first' },
        400: invalidRequest,
        401: unauthenticated,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    validator(
      'query',
      z.object({ kind: z.string().min(1).max(60).optional().describe('Only subjects of this kind.') })
    ),
    async c => {
      const { id } = c.req.valid('param');
      const { kind } = c.req.valid('query');
      const session = await useServices().session(usePrincipal());
      const rows = await session.transaction(tx =>
        tx
          .select({ id: subjects.id, kind: subjects.kind, label: subjects.label, createdAt: subjects.createdAt })
          .from(subjects)
          .where(and(eq(subjects.organisationId, id), kind === undefined ? undefined : eq(subjects.kind, kind)))
          .orderBy(subjects.id)
      );
      c.header('Cache-Control', 'no-store');
      return c.json({ subjects: rows }, 200);
    }
  )
  .post(
    '/:id/subjects',
    describeRoute({
      operationId: 'organisations.subjects.create',
      ...operationVersion(1),
      summary: 'Add an external subject',
      description:
        "Administrators only. Something agents observe that isn't part of the topology, such as a website. Topology entities get their subjects when they are created, so their kinds are refused here.",
      responses: {
        201: { description: 'The new subject' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    validator(
      'json',
      z.strictObject({
        kind: z
          .string()
          .trim()
          .min(1)
          .max(60)
          .refine(kind => !TOPOLOGY_KINDS.has(kind), 'That kind belongs to the topology entities')
          .describe('What the subject is, such as `website`.'),
        label: SubjectLabelSchema.default(null)
      })
    ),
    async c => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const session = await useServices().session(usePrincipal());
      const [row] = await session.transaction(tx =>
        tx
          .insert(subjects)
          .values({ organisationId: id, kind: body.kind, label: body.label })
          .returning({ id: subjects.id, kind: subjects.kind, label: subjects.label, createdAt: subjects.createdAt })
      );
      c.header('Cache-Control', 'no-store');
      return c.json(row!, 201);
    }
  )
  .get(
    '/:id/subjects/:subjectId',
    describeRoute({
      operationId: 'organisations.subjects.get',
      ...operationVersion(1),
      summary: 'Read a subject',
      responses: {
        200: { description: 'The subject' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', SubjectParamsSchema),
    async c => {
      const { id, subjectId } = c.req.valid('param');
      const session = await useServices().session(usePrincipal());
      const [row] = await session.transaction(tx =>
        tx
          .select({ id: subjects.id, kind: subjects.kind, label: subjects.label, createdAt: subjects.createdAt })
          .from(subjects)
          .where(and(eq(subjects.organisationId, id), eq(subjects.id, subjectId)))
      );
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .patch(
    '/:id/subjects/:subjectId',
    describeRoute({
      operationId: 'organisations.subjects.update',
      ...operationVersion(1),
      summary: 'Relabel a subject',
      description:
        'Administrators only. Labels are for display; the subject ID is its identity. Renaming a topology entity relabels its subject too.',
      responses: {
        200: { description: 'The updated subject' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', SubjectParamsSchema),
    validator('json', z.strictObject({ label: SubjectLabelSchema })),
    async c => {
      const { id, subjectId } = c.req.valid('param');
      const { label } = c.req.valid('json');
      const session = await useServices().session(usePrincipal());
      const row = await session.transaction(async tx => {
        const [subject] = await tx
          .update(subjects)
          .set({ label })
          .where(and(eq(subjects.organisationId, id), eq(subjects.id, subjectId)))
          .returning({ id: subjects.id, kind: subjects.kind, label: subjects.label, createdAt: subjects.createdAt });
        if (!subject) throw await unchanged(tx, subjects.id, subjectId);
        return subject;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:id/subjects/:subjectId',
    describeRoute({
      operationId: 'organisations.subjects.delete',
      ...operationVersion(1),
      summary: 'Delete a subject',
      description: 'Administrators only. Refused while a topology entity still uses it.',
      responses: {
        204: { description: 'Deleted' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        409: inUse,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', SubjectParamsSchema),
    async c => {
      const { id, subjectId } = c.req.valid('param');
      const session = await useServices().session(usePrincipal());
      await session.transaction(async tx => {
        const deleted = await tx
          .delete(subjects)
          .where(and(eq(subjects.organisationId, id), eq(subjects.id, subjectId)))
          .returning({ id: subjects.id });
        if (deleted.length === 0) throw await unchanged(tx, subjects.id, subjectId);
      });
      return c.body(null, 204);
    }
  );
