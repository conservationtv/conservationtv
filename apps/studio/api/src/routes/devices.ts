import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { devices, subjects } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { requirePrincipal, usePrincipal } from '../middleware/principal.ts';
import { useServices } from '../services.ts';
import { NativeExposureSchema, NetworkReferenceSchema, SettingsSchema } from '../topology/settings.ts';
import { newSubject, unchanged } from '../topology/transaction.ts';
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

const DeviceTypeSchema = z.string().trim().min(1).max(60).describe('What the device is, such as `camera` or `server`.');
export type DeviceType = z.output<typeof DeviceTypeSchema>;
const DeviceNameSchema = z.string().trim().min(1).max(120).describe('The device name.');
export type DeviceName = z.output<typeof DeviceNameSchema>;
const NativeExposuresSchema = z
  .array(NativeExposureSchema)
  .max(32)
  .describe('The endpoints the device offers by itself, such as a camera’s RTSP feed.');
export type NativeExposures = z.output<typeof NativeExposuresSchema>;

// An organisation's devices (cameras, servers), in the principal's request session: members read them, administrators
// manage them. Each device has a subject of its own, labelled with its name.
export default new Hono()
  .get(
    '/:id/devices',
    describeRoute({
      operationId: 'organisations.devices.list',
      ...operationVersion(1),
      summary: "List an organisation's devices",
      description: 'Empty for organisations you are not a member of.',
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
    async c => {
      const { id } = c.req.valid('param');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const rows = await session.transaction(tx =>
        tx
          .select({
            id: devices.id,
            subjectId: devices.subjectId,
            type: devices.type,
            name: devices.name,
            networkId: devices.networkId,
            nativeExposures: devices.nativeExposures,
            settings: devices.settings,
            createdAt: devices.createdAt
          })
          .from(devices)
          .where(eq(devices.organisationId, id))
          .orderBy(devices.id)
      );
      c.header('Cache-Control', 'no-store');
      return c.json({ devices: rows }, 200);
    }
  )
  .post(
    '/:id/devices',
    describeRoute({
      operationId: 'organisations.devices.create',
      ...operationVersion(1),
      summary: 'Add a device',
      description: 'Administrators only. The device gets a subject of its own.',
      responses: {
        201: { description: 'The new device' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        412: versionMismatch,
        422: invalidReference,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    validator(
      'json',
      z.strictObject({
        type: DeviceTypeSchema,
        name: DeviceNameSchema,
        networkId: NetworkReferenceSchema.default(null),
        nativeExposures: NativeExposuresSchema.default([]),
        settings: SettingsSchema.default({})
      })
    ),
    async c => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const [row] = await session.transaction(async tx =>
        tx
          .insert(devices)
          .values({
            organisationId: id,
            subjectId: await newSubject(tx, id, 'device', body.name),
            type: body.type,
            name: body.name,
            networkId: body.networkId,
            nativeExposures: body.nativeExposures,
            settings: body.settings
          })
          .returning({
            id: devices.id,
            subjectId: devices.subjectId,
            type: devices.type,
            name: devices.name,
            networkId: devices.networkId,
            nativeExposures: devices.nativeExposures,
            settings: devices.settings,
            createdAt: devices.createdAt
          })
      );
      c.header('Cache-Control', 'no-store');
      return c.json(row!, 201);
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
          .select({
            id: devices.id,
            subjectId: devices.subjectId,
            type: devices.type,
            name: devices.name,
            networkId: devices.networkId,
            nativeExposures: devices.nativeExposures,
            settings: devices.settings,
            createdAt: devices.createdAt
          })
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
      summary: 'Update a device',
      description:
        "Administrators only. Changes only the fields given; `nativeExposures` and `settings` are replaced whole. Renaming relabels the device's subject too.",
      responses: {
        200: { description: 'The updated device' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
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
        .strictObject({
          type: DeviceTypeSchema.optional(),
          name: DeviceNameSchema.optional(),
          networkId: NetworkReferenceSchema.optional(),
          nativeExposures: NativeExposuresSchema.optional(),
          settings: SettingsSchema.optional()
        })
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
          .set({
            type: body.type,
            name: body.name,
            networkId: body.networkId,
            nativeExposures: body.nativeExposures,
            settings: body.settings
          })
          .where(and(eq(devices.organisationId, id), eq(devices.id, deviceId)))
          .returning({
            id: devices.id,
            subjectId: devices.subjectId,
            type: devices.type,
            name: devices.name,
            networkId: devices.networkId,
            nativeExposures: devices.nativeExposures,
            settings: devices.settings,
            createdAt: devices.createdAt
          });
        if (!device) throw await unchanged(tx, devices.id, deviceId);
        if (body.name !== undefined)
          await tx.update(subjects).set({ label: body.name }).where(eq(subjects.id, device.subjectId));
        return device;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:id/devices/:deviceId',
    describeRoute({
      operationId: 'organisations.devices.delete',
      ...operationVersion(1),
      summary: 'Remove a device',
      description:
        'Administrators only. Refused while an agent runs on it or a stream uses it as its source. Its subject remains until the subject is deleted.',
      responses: {
        204: { description: 'Removed' },
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
    validator('param', DeviceParamsSchema),
    async c => {
      const { id, deviceId } = c.req.valid('param');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      await session.transaction(async tx => {
        const deleted = await tx
          .delete(devices)
          .where(and(eq(devices.organisationId, id), eq(devices.id, deviceId)))
          .returning({ id: devices.id });
        if (deleted.length === 0) throw await unchanged(tx, devices.id, deviceId);
      });
      return c.body(null, 204);
    }
  );
