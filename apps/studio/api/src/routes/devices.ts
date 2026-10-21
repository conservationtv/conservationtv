import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { devices } from '../db/schema.ts';
import { transaction, useDB } from '../db/transaction.ts';
import { ApiFailure } from '../errors.ts';
import { requirePrincipal } from '../middleware/principal.ts';
import { DEVICE_KINDS } from '../topology/device-kinds.ts';
import { deviceKeyPair } from '../topology/identity.ts';
import { NetworkReferenceSchema } from '../topology/settings.ts';
import { unchanged } from '../topology/transaction.ts';
import {
  forbidden,
  inUse,
  invalidReference,
  invalidRequest,
  noCaller,
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

// An organisation's devices, in the principal's request session: members read them, administrators rename and move
// them. A device is created and removed as its kind: under /agents or /cameras, which share its ID, or as a session's
// browser (/browser). Administrators alone read a device's private key. Devices themselves, signing their requests, read
// only the organisation's public IDs.
export default new Hono()
  .get(
    '/allowlist',
    describeRoute({
      operationId: 'organisations.devices.allowlist',
      ...operationVersion(1),
      summary: "List the public IDs of an organisation's devices",
      description:
        "Every device's iroh endpoint ID, for an allowlist. Members call it signed in; devices call it with an RFC 9421 HTTP Message Signature by their own identity, as for `reports.submit`. Empty for organisations you are not a member of, or a signing device does not belong to.",
      responses: {
        200: { description: 'The public IDs, oldest device first' },
        400: invalidRequest,
        401: noCaller,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    async c => {
      const { id } = c.req.valid('param');
      const [row] = await transaction(async () => {
        const db = useDB();
        return db
          .select({
            publicIds: sql<string[]>`coalesce(array_agg(${devices.publicId} order by ${devices.id}), '{}')`
          })
          .from(devices)
          .where(eq(devices.organisationId, id));
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .get(
    '/',
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
      const rows = await transaction(async () => {
        const db = useDB();
        return db
          .select({
            id: devices.id,
            kind: devices.kind,
            name: devices.name,
            networkId: devices.networkId,
            publicKey: devices.publicKey,
            publicId: devices.publicId,
            createdAt: devices.createdAt
          })
          .from(devices)
          .where(and(eq(devices.organisationId, id), kind === undefined ? undefined : eq(devices.kind, kind)))
          .orderBy(devices.id);
      });
      c.header('Cache-Control', 'no-store');
      return c.json({ devices: rows }, 200);
    }
  )
  .get(
    '/:deviceId',
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
      const [row] = await transaction(async () => {
        const db = useDB();
        return db
          .select({
            id: devices.id,
            kind: devices.kind,
            name: devices.name,
            networkId: devices.networkId,
            publicKey: devices.publicKey,
            publicId: devices.publicId,
            createdAt: devices.createdAt
          })
          .from(devices)
          .where(and(eq(devices.organisationId, id), eq(devices.id, deviceId)));
      });
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .get(
    '/:deviceId/key-pair',
    describeRoute({
      operationId: 'organisations.devices.getKeyPair',
      ...operationVersion(1),
      summary: "Read a device's key pair",
      description:
        'Administrators only. The Ed25519 identity the device was created with: its public key (unpadded base64url), its public ID (the iroh endpoint ID, lowercase hex) and its private key (the raw 32-byte seed, unpadded base64url), so the device can be provisioned to act as it.',
      responses: {
        200: { description: 'The key pair' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', DeviceParamsSchema),
    async c => {
      const { id, deviceId } = c.req.valid('param');
      const keyPair = await deviceKeyPair(id, deviceId);
      const privateKey = Buffer.from(keyPair.privateKey).toString('base64url');
      c.header('Cache-Control', 'no-store');
      return c.json({ ...keyPair, privateKey }, 200);
    }
  )
  .patch(
    '/:deviceId',
    describeRoute({
      operationId: 'organisations.devices.update',
      ...operationVersion(1),
      summary: 'Rename or move a device',
      description:
        'Administrators only. Changes only the fields given. An agent’s network cannot change, and a browser stays on the internet.',
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
      const row = await transaction(async () => {
        const db = useDB();
        const [device] = await db
          .update(devices)
          .set({ name: body.name, networkId: body.networkId })
          .where(and(eq(devices.organisationId, id), eq(devices.id, deviceId)))
          .returning({
            id: devices.id,
            kind: devices.kind,
            name: devices.name,
            networkId: devices.networkId,
            publicKey: devices.publicKey,
            publicId: devices.publicId,
            createdAt: devices.createdAt
          });
        if (!device) throw await unchanged(devices.id, deviceId);
        return device;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  );
