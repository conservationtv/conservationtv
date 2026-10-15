import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { users } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { requirePrincipal, usePrincipal } from '../middleware/principal.ts';
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

// The signed-in account's own row, read and edited through its request session: row-level security, not the query,
// decides which row that is. Versions belong to individual operations; keep their declarations together.
export default new Hono()
  .get(
    '/',
    describeRoute({
      operationId: 'account.get',
      ...operationVersion(1),
      summary: 'Read your account',
      description: 'The signed-in account, as its row-level security lets it see itself.',
      responses: {
        200: { description: 'The signed-in account' },
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    async c => {
      const principal = usePrincipal();
      const services = useServices();
      const session = await services.session(principal);
      const [row] = await session.transaction(tx =>
        tx
          .select({
            id: users.id,
            name: users.name,
            email: users.email,
            emailVerified: users.emailVerified,
            image: users.image,
            createdAt: users.createdAt
          })
          .from(users)
          .where(eq(users.id, principal.id))
      );
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .patch(
    '/',
    describeRoute({
      operationId: 'account.update',
      ...operationVersion(1),
      summary: 'Update your account',
      description:
        'Changes the profile fields of the signed-in account. Email and verification change through `/auth`.',
      responses: {
        200: { description: 'The updated account' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator(
      'json',
      z
        .strictObject({
          name: z.string().trim().min(1).max(120).optional().describe('The display name.'),
          image: z.url().max(2048).nullable().optional().describe('An avatar URL, or null to remove it.')
        })
        .refine(changes => Object.keys(changes).length > 0, 'Provide at least one field to change')
    ),
    async c => {
      const principal = usePrincipal();
      const changes = c.req.valid('json');
      const services = useServices();
      const session = await services.session(principal);
      const [row] = await session.transaction(tx =>
        tx.update(users).set(changes).where(eq(users.id, principal.id)).returning({
          id: users.id,
          name: users.name,
          email: users.email,
          emailVerified: users.emailVerified,
          image: users.image,
          createdAt: users.createdAt
        })
      );
      // An update that reaches no row means the account is not visible to this session.
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  );
