import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { devices } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { requirePrincipal, usePrincipal } from '../middleware/principal.ts';
import { useServices } from '../services.ts';
import { DEVICE_KINDS } from '../topology/device-kinds.ts';
import { NetworkReferenceSchema } from '../topology/settings.ts';
import { unchanged } from '../topology/transaction.ts';
import {
  forbidden,
  inUse,
  invalidReference,
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
const DeviceParamsSchema = OrganisationParamsSchema.extend({ deviceId: z.uuid().describe('The device.') });
export type DeviceParams = z.output<typeof DeviceParamsSchema>;

export const DeviceNameSchema = z.string().trim().min(1).max(120).describe('The device name.');
export type DeviceName = z.output<typeof DeviceNameSchema>;

/** A device: the columns every device route returns, and that its kind's routes return too. */
export const deviceColumns = {
  id: devices.id,
  kind: devices.kind,
  name: devices.name,
  networkId: devices.networkId,
  publicKey: devices.publicKey,
  publicId: devices.publicId,
  createdAt: devices.createdAt
};

// An organisation's devices, in the principal's request session: members read them, administrators rename and move
// them. A device is created and removed as its kind: under /agents or /cameras, which share its ID, or as a session's
// browser (/browser).
export default new Hono()
  .get(
    '/:id/devices',
    describeRoute({
      operationId: 'organisations.devices.list',
      ...operationVersion(1),
      summary: "List an organisation's devices",
      description: `Every kind (${DEVICE_KINDS.join(', ')}), optionally only one. Empty for organisations you are not a member of.`,
      responses: {
        200: { description: 'The devices, oldest first' },
        400: invalidRequest,
        401: unauthenticated,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    validator('query', z.object({ kind: z.enum(DEVICE_KINDS).optional().describe('Only devices of this kind.') })),
    async c => {
      const { id } = c.req.valid('param');
      const { kind } = c.req.valid('query');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const rows = await session.transaction(tx =>
        tx
          .select(deviceColumns)
          .from(devices)
          .where(and(eq(devices.organisationId, id), kind === undefined ? undefined : eq(devices.kind, kind)))
          .orderBy(devices.id)
      );
      c.header('Cache-Control', 'no-store');
      return c.json({ devices: rows }, 200);
    }
  )
  .get(
    '/:id/devices/:deviceId',
    describeRoute({
      operationId: 'organisations.devices.get',
      ...operationVersion(1),
      summary: 'Read a device',
      responses: {
        200: { description: 'The device' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', DeviceParamsSchema),
    async c => {
      const { id, deviceId } = c.req.valid('param');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const [row] = await session.transaction(tx =>
        tx
          .select(deviceColumns)
          .from(devices)
          .where(and(eq(devices.organisationId, id), eq(devices.id, deviceId)))
      );
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .patch(
    '/:id/devices/:deviceId',
    describeRoute({
      operationId: 'organisations.devices.update',
      ...operationVersion(1),
      summary: 'Rename or move a device',
      description: 'Administrators only. Changes only the fields given. An agent’s network cannot change, and a browser stays on the internet.',
      responses: {
        200: { description: 'The updated device' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        409: inUse,
        412: versionMismatch,
        422: invalidReference,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', DeviceParamsSchema),
    validator(
      'json',
      z
        .strictObject({ name: DeviceNameSchema.optional(), networkId: NetworkReferenceSchema.optional() })
        .refine(changes => Object.keys(changes).length > 0, 'Provide at least one field to change')
    ),
    async c => {
      const { id, deviceId } = c.req.valid('param');
      const body = c.req.valid('json');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const row = await session.transaction(async tx => {
        const [device] = await tx
          .update(devices)
          .set({ name: body.name, networkId: body.networkId })
          .where(and(eq(devices.organisationId, id), eq(devices.id, deviceId)))
          .returning(deviceColumns);
        if (!device) throw await unchanged(tx, devices.id, deviceId);
        return device;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  );
