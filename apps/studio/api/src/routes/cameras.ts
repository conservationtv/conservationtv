import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { cameras, devices } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { requirePrincipal, usePrincipal } from '../middleware/principal.ts';
import { useServices } from '../services.ts';
import { changeDevices, grantDevice, revokeDevice } from '../topology/device-principals.ts';
import { deviceIdentity } from '../topology/identity.ts';
import { NativeExposureSchema, NetworkReferenceSchema, SettingsSchema } from '../topology/settings.ts';
import type { Transaction } from '../organisations/membership.ts';
import { unchanged } from '../topology/transaction.ts';
import { DeviceNameSchema, deviceQuery } from './devices.ts';
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
const CameraParamsSchema = OrganisationParamsSchema.extend({ cameraId: z.uuid().describe('The camera.') });
export type CameraParams = z.output<typeof CameraParamsSchema>;

const NativeExposuresSchema = z
  .array(NativeExposureSchema)
  .max(32)
  .describe('The endpoints the camera offers by itself, such as its RTSP feed.');
export type NativeExposures = z.output<typeof NativeExposuresSchema>;

/** A camera as every camera route returns it: its own fields and its device's. */
const cameraQuery = {
  columns: { id: true, nativeExposures: true, settings: true },
  with: { device: deviceQuery }
} as const;

/** The camera, as its routes return it. */
function readCamera(tx: Transaction, organisationId: string, cameraId: string) {
  return tx.query.cameras.findFirst({ ...cameraQuery, where: { organisationId, id: cameraId } });
}

// An organisation's cameras, in the principal's request session: members read them, administrators manage them. A
// camera is a device (src/db/schemas/cameras.ts): it is created and removed with its device, and its device's name and
// network are edited under /devices, with the same ID.
export default new Hono()
  .get(
    '/:id/cameras',
    describeRoute({
      operationId: 'organisations.cameras.list',
      ...operationVersion(1),
      summary: "List an organisation's cameras",
      description: 'Empty for organisations you are not a member of.',
      responses: {
        200: { description: 'The cameras, oldest first' },
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
        tx.query.cameras.findMany({ ...cameraQuery, where: { organisationId: id }, orderBy: { id: 'asc' } })
      );
      c.header('Cache-Control', 'no-store');
      return c.json({ cameras: rows }, 200);
    }
  )
  .post(
    '/:id/cameras',
    describeRoute({
      operationId: 'organisations.cameras.create',
      ...operationVersion(1),
      summary: 'Add a camera',
      description: 'Administrators only. Creates the camera’s device, with a new Ed25519 identity, and the camera.',
      responses: {
        201: { description: 'The new camera' },
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
        name: DeviceNameSchema,
        networkId: NetworkReferenceSchema.default(null),
        nativeExposures: NativeExposuresSchema.default([]),
        settings: SettingsSchema.default({})
      })
    ),
    async c => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const principal = usePrincipal();
      const identity = await deviceIdentity();
      // Trusted, so the device's principal grant is made with it (src/topology/device-principals.ts).
      const row = await changeDevices(principal, id, 'create', async (tx, access) => {
        const [device] = await tx
          .insert(devices)
          .values({ ...identity, organisationId: id, kind: 'camera', name: body.name, networkId: body.networkId })
          .returning({ id: devices.id });
        await tx.insert(cameras).values({
          id: device!.id,
          organisationId: id,
          nativeExposures: body.nativeExposures,
          settings: body.settings
        });
        await grantDevice(access, id, device!.id);
        const camera = await readCamera(tx, id, device!.id);
        return camera!;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 201);
    }
  )
  .get(
    '/:id/cameras/:cameraId',
    describeRoute({
      operationId: 'organisations.cameras.get',
      ...operationVersion(1),
      summary: 'Read a camera',
      responses: {
        200: { description: 'The camera' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', CameraParamsSchema),
    async c => {
      const { id, cameraId } = c.req.valid('param');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const row = await session.transaction(tx => readCamera(tx, id, cameraId));
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .patch(
    '/:id/cameras/:cameraId',
    describeRoute({
      operationId: 'organisations.cameras.update',
      ...operationVersion(1),
      summary: 'Update a camera',
      description:
        'Administrators only. Changes only the fields given; `nativeExposures` and `settings` are replaced whole. Its name and network are changed under `/devices`, with the same ID.',
      responses: {
        200: { description: 'The updated camera' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', CameraParamsSchema),
    validator(
      'json',
      z
        .strictObject({ nativeExposures: NativeExposuresSchema.optional(), settings: SettingsSchema.optional() })
        .refine(changes => Object.keys(changes).length > 0, 'Provide at least one field to change')
    ),
    async c => {
      const { id, cameraId } = c.req.valid('param');
      const body = c.req.valid('json');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const row = await session.transaction(async tx => {
        const updated = await tx
          .update(cameras)
          .set({ nativeExposures: body.nativeExposures, settings: body.settings })
          .where(and(eq(cameras.organisationId, id), eq(cameras.id, cameraId)))
          .returning({ id: cameras.id });
        if (updated.length === 0) throw await unchanged(tx, cameras.id, cameraId);
        const camera = await readCamera(tx, id, cameraId);
        return camera!;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:id/cameras/:cameraId',
    describeRoute({
      operationId: 'organisations.cameras.delete',
      ...operationVersion(1),
      summary: 'Remove a camera',
      description: 'Administrators only. Removes its device too. Refused while a stream uses it as its source.',
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
    validator('param', CameraParamsSchema),
    async c => {
      const { id, cameraId } = c.req.valid('param');
      const principal = usePrincipal();
      // Trusted, so the device's principal grant is revoked with it (src/topology/device-principals.ts).
      await changeDevices(principal, id, 'remove', async (tx, access) => {
        const deleted = await tx
          .delete(cameras)
          .where(and(eq(cameras.organisationId, id), eq(cameras.id, cameraId)))
          .returning({ id: cameras.id });
        if (deleted.length === 0) throw new ApiFailure('not_found');
        await tx.delete(devices).where(and(eq(devices.organisationId, id), eq(devices.id, cameraId)));
        await revokeDevice(access, id, cameraId);
      });
      return c.body(null, 204);
    }
  );
