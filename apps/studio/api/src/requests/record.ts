import { createStore } from '@conservationtv/store';
import type { AccessChange } from '@conservationtv/umbrella';
import type { CommonFailureCode, SelectedOperation } from '@conservationtv/versioned-api/server';
import { createMiddleware } from 'hono/factory';
import type { ApiFailureCode } from '../errors.ts';
import type { RequestPrincipal } from '../middleware/principal.ts';
import type { DeviceKind } from '../topology/device-kinds.ts';

// What a request did, gathered once, as it runs, by the pieces that already know each part: the router names the
// operation (`recordOperation`), the principal and device middleware the actor, the error handler the failure, and
// trusted transactions the grants they committed. Nothing else needs to report into it. Whatever is told about requests
// afterwards (an audit entry, a trace) reads it from here rather than asking each handler.

/** Who made the request. */
export interface RequestActor {
  principal: RequestPrincipal;
  /** The sign-in session a user presented. */
  sessionId?: string;
  /** The kind of the device that signed the request. */
  deviceKind?: DeviceKind;
}

/** The operation the request was routed to. */
export interface RecordedOperation {
  id: string;
  /** Absent for a versionless operation. */
  version?: number;
  method: string;
  /** The route, with its parameter names: `/organisations/:id/devices/:deviceId`. */
  path: string;
  /** The path parameters, decoded. */
  params: Record<string, string>;
  /** What the operation acts on: its path parameters besides the organisation's, e.g. `{ deviceId: '…' }`. */
  targets: Record<string, string>;
}

/** A failure's code, as the error handler rendered it: the API's own, or a common one (routing, validation, 500s). */
export type RequestFailureCode = ApiFailureCode | CommonFailureCode;

export interface RequestRecord {
  /** Absent for requests no operation serves: CORS preflights, Better Auth's routes, static files, unknown paths. */
  operation?: RecordedOperation;
  /** Absent until the request is authenticated, and for requests that never are. */
  actor?: RequestActor;
  /**
   * The organisation the request acted in: the one its path names, or else the one the signing device belongs to, or
   * one a handler named with `recordOrganisation` when neither says (creating an organisation, answering an
   * invitation).
   */
  organisationId?: string;
  /** Grants stored or removed by trusted transactions that committed, in order. */
  accessChanges: AccessChange[];
  /** The response status, once the request has been handled. */
  status?: number;
  /** The failure the request ended in, as the error handler rendered it. */
  failure?: RequestFailureCode;
}

const [withRequestRecord, useRequestRecord] = createStore<RequestRecord>('requestRecord');
export { useRequestRecord };

/** The request's record, or undefined outside a request (a Durable Object, or work the response did not wait for). */
function currentRecord(): RequestRecord | undefined {
  try {
    return useRequestRecord();
  } catch {
    return undefined;
  }
}

/** An organisation route's own: `/organisations/:id` and everything under it. */
const ORGANISATION_PATH = /^\/organisations\/:id(\/|$)/;

/** The operation the router selected (`aroundOperation`, src/app.ts), and its organisation if its path names one. */
export function recordOperation({ operation, params }: SelectedOperation) {
  const record = currentRecord();
  if (!record) return;
  const { operationId: id, version, method, path } = operation;
  if (!ORGANISATION_PATH.test(path)) {
    record.operation = { id, version, method, path, params, targets: params };
    return;
  }
  const { id: organisationId, ...targets } = params;
  record.operation = { id, version, method, path, params, targets };
  record.organisationId = organisationId;
}

/** Who the request runs as: told by `requirePrincipal` and `requireDevice` once they have authenticated it. */
export function recordActor(actor: RequestActor) {
  const record = currentRecord();
  if (!record) return;
  record.actor = actor;
}

/** The organisation the request acted in, for the few operations whose path doesn't say: see `RequestRecord`. */
export function recordOrganisation(organisationId: string) {
  const record = currentRecord();
  if (!record) return;
  record.organisationId = organisationId;
}

/** The organisation a signing device belongs to, when the path named none. */
export function recordDeviceOrganisation(organisationId: string) {
  const record = currentRecord();
  if (!record || record.organisationId !== undefined) return;
  record.organisationId = organisationId;
}

/** The failure the request ended in: told by the error handler (src/middleware/errors.ts), which renders every one. */
export function recordFailure(failure: RequestFailureCode) {
  const record = currentRecord();
  if (!record) return;
  record.failure = failure;
}

/** Grants a trusted transaction stored or removed, once it has committed. */
export function recordAccessChanges(changes: readonly AccessChange[]) {
  const record = currentRecord();
  if (!record) return;
  record.accessChanges.push(...changes);
}

/**
 * Keep a record of the request while it runs. First, so it sees every request and every failure: the error handler
 * renders a thrown failure as the response before this resumes, so the status here is always what was sent.
 */
export const recordRequest = createMiddleware(async (c, next) => {
  const record: RequestRecord = { accessChanges: [] };
  await withRequestRecord(record, next);
  record.status = c.res.status;
});
