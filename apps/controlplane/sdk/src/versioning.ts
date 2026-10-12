import * as z from 'zod';
import {
  ClientTransport,
  type BoundMethod,
  type OperationOutcome,
  type ResultCall,
  type SdkClass,
  type SdkMethod
} from './client.js';
import { asError } from './errors.js';

// The runtime behind the generated Client. A versioned operation exposes every version this client was
// generated with (`v1`, `v2`, ...) and the version negotiated with the server (`version`). The server can serve multiple versions
// of each; `handshake` reads which from the OpenAPI document it publishes. A versionless operation, one the spec gives
// no version, is the plain SDK method: no handshake, no header, and no compatibility guarantees.

export const OPERATION_VERSION_HEADER = 'Operation-Version';

/** Where the API publishes the OpenAPI document it was generated with. */
export const PUBLISHED_DOCUMENT_URL = '/openapi.json';

// The parts of the published document the handshake reads. An operation without `x-operation-version` is versionless.
const PublishedOperationSchema = z.object({
  operationId: z.string(),
  'x-operation-version': z.number().int().positive().optional(),
  'x-operation-versions': z.array(z.number().int().positive()).nonempty().optional()
});
export type PublishedOperation = z.output<typeof PublishedOperationSchema>;
const PublishedPathItemSchema = z.object({
  get: PublishedOperationSchema.optional(),
  put: PublishedOperationSchema.optional(),
  post: PublishedOperationSchema.optional(),
  delete: PublishedOperationSchema.optional(),
  patch: PublishedOperationSchema.optional(),
  options: PublishedOperationSchema.optional(),
  head: PublishedOperationSchema.optional(),
  trace: PublishedOperationSchema.optional()
});
export type PublishedPathItem = z.output<typeof PublishedPathItemSchema>;
export const PublishedDocumentSchema = z.object({ paths: z.record(z.string(), PublishedPathItemSchema) });
export type PublishedDocument = z.output<typeof PublishedDocumentSchema>;

export type { ClientConfig, SdkClassArgs, SdkClass, SdkMethod } from './client.js';

type VersionKey = `v${number}`;

/** An operation's versions, each mapped to the BaseClient generated from the spec that defines it. */
export type OperationVersions = Partial<Record<VersionKey, SdkClass>>;

type VersionNumber<Key> = Key extends `v${infer N extends number}` ? N : never;
type VersionKeys<Versions> = keyof Versions & VersionKey;

export interface VersionTag<Version extends number> {
  readonly version: Version;
}

/** One version of an operation: the generated SDK method, tagged with its version. */
export type VersionedCall<Method, Version extends number> = Method & VersionTag<Version>;

type CallFor<Id extends string, Versions, Key> =
  Key extends VersionKeys<Versions>
    ? VersionedCall<ResultCall<SdkMethod<Versions[Key], Id>>, VersionNumber<Key>>
    : never;

export interface OperationState<Id extends string, Versions> {
  readonly operationId: Id;
  /**
   * The version negotiated with the server, or `undefined` if it serves none of the versions this client has. Throws
   * before `handshake`.
   */
  readonly version: VersionNumber<VersionKeys<Versions>> | undefined;
}

export type VersionedOperation<Id extends string, Versions extends OperationVersions> = OperationState<Id, Versions> & {
  readonly [Key in VersionKeys<Versions>]: CallFor<Id, Versions, Key>;
};

/** An operation call returns this error before a successful handshake; the version getter still throws it. */
export class HandshakeRequiredError extends Error {
  constructor(readonly operationId: string) {
    super(`Call handshake() before using ${operationId}`);
  }
}

/** Fetching the server's published OpenAPI document failed, or it isn't one. */
export class HandshakeError extends Error {}

/** The client called a version of an operation that the server doesn't serve. */
export class OperationVersionUnavailableError extends Error {
  constructor(
    readonly operationId: string,
    readonly requested: number,
    readonly negotiated: number | undefined
  ) {
    super(
      negotiated === undefined
        ? `The server serves no version of ${operationId} that this client supports`
        : `The server does not serve ${operationId} at version ${requested}; highest shared version is ${negotiated}`
    );
  }
}

/**
 * The server changed an operation's version between the handshake and a call, for example during a deploy. The call
 * wasn't retried, because its arguments were built for the old version; check the operation's `version` again.
 */
export class OperationVersionChangedError extends Error {
  constructor(
    readonly operationId: string,
    readonly previous: number,
    readonly current: number | undefined
  ) {
    super(`${operationId} changed from version ${previous} to ${current ?? 'unsupported'} on the server`);
  }
}

export class ClientCore extends ClientTransport {
  /** The versions this client has of each operation, filled by `versioned` as the generated class initialises. */
  private readonly supported = new Map<string, number[]>();
  private negotiated: Map<string, number> | undefined;
  private available = new Map<string, number[]>();
  private pendingHandshake: Promise<void> | undefined;

  /**
   * Reads all versions of each versioned operation the server serves from its published OpenAPI document. Call before
   * any versioned operation, and again to refresh. Rejects with HandshakeError on failure.
   * Versionless operations don't need it.
   */
  handshake(): Promise<void> {
    // Concurrent calls that hit a version mismatch share one handshake.
    if (this.pendingHandshake == null) {
      this.pendingHandshake = this.readPublishedDocument()
        .catch(error => {
          throw error instanceof HandshakeError ? error : new HandshakeError('Handshake failed', { cause: error });
        })
        .finally(() => {
          this.pendingHandshake = undefined;
        });
    }
    return this.pendingHandshake;
  }

  /** Registers a versioned operation's versions. The generated Client calls this once per operation. */
  protected versioned<const Id extends string, const Versions extends OperationVersions>(
    operationId: Id,
    versions: Versions
  ): VersionedOperation<Id, Versions> {
    const calls = new Map<string, VersionTag<number>>();
    for (const [key, sdk] of Object.entries(versions)) {
      if (sdk) calls.set(key, this.versionedCall(operationId, Number(key.slice(1)), sdk));
    }
    this.supported.set(
      operationId,
      [...calls.values()].map(call => call.version)
    );
    const versionOf = () => this.versionOf(operationId);
    const state = {
      operationId,
      get version() {
        return versionOf();
      }
    };
    // SAFETY: `state` implements OperationState for these versions, and `calls` holds a tagged call for each key of
    // `versions`, which is what the mapped type adds.
    return Object.assign(state, Object.fromEntries(calls)) as VersionedOperation<Id, Versions>;
  }

  /** Unversioned operations use the same success-body-or-Error result as versioned calls. */
  protected versionless<const Id extends string, Sdk extends SdkClass>(
    operationId: Id,
    sdk: Sdk
  ): ResultCall<SdkMethod<Sdk, Id>> {
    return this.operation(operationId, sdk);
  }

  /** Fetch and validate the published document, then negotiate every operation against it at once. */
  private async readPublishedDocument(): Promise<void> {
    const result = await this.http.get({ url: PUBLISHED_DOCUMENT_URL });
    const parsed = PublishedDocumentSchema.safeParse(result.data);
    if (!parsed.success) {
      const status = result.response?.status ?? 'no response';
      throw new HandshakeError(`GET ${PUBLISHED_DOCUMENT_URL} failed (${status})`, {
        cause: result.error ?? parsed.error
      });
    }
    const { negotiated, available } = negotiate(parsed.data, this.supported);
    this.negotiated = negotiated;
    this.available = available;
  }

  private versionOf(operationId: string): number | undefined {
    if (!this.negotiated) throw new HandshakeRequiredError(operationId);
    return this.negotiated.get(operationId);
  }

  private versionedCall(operationId: string, version: number, sdk: SdkClass): VersionTag<number> {
    const method = this.method(sdk, operationId);
    const call = async (...args: unknown[]) => {
      try {
        return await this.invoke(operationId, version, method, args);
      } catch (error) {
        return asError(error);
      }
    };
    return Object.assign(call, { version });
  }

  /** Refresh after a protocol rejection; retry only the same requested version, once. */
  private async invoke(
    operationId: string,
    version: number,
    method: BoundMethod,
    args: unknown[]
  ): Promise<OperationOutcome> {
    const negotiated = this.versionOf(operationId);
    if (!this.available.get(operationId)?.includes(version))
      return new OperationVersionUnavailableError(operationId, version, negotiated);

    const first = await this.send(method, args, version);
    if (!first.mismatched) return first.result;
    await this.handshake();
    const current = this.versionOf(operationId);
    if (!this.available.get(operationId)?.includes(version))
      return new OperationVersionChangedError(operationId, version, current);
    return (await this.send(method, args, version)).result;
  }
}

/** Validate the advertised set; a legacy document advertises only its described version. */
function servedVersions(operation: PublishedOperation): number[] {
  const described = operation['x-operation-version'];
  const served = operation['x-operation-versions'] ?? (described === undefined ? [] : [described]);
  if (
    served.length &&
    (described === undefined || !served.includes(described) || new Set(served).size !== served.length)
  ) {
    throw new HandshakeError(`Invalid served versions for ${operation.operationId}`);
  }
  return served;
}

/** Negotiate each operation independently, retaining all shared versions for explicit vN calls. */
function negotiate(document: PublishedDocument, supported: Map<string, number[]>) {
  const operations = Object.values(document.paths).flatMap(item => Object.values(item));
  const negotiated = new Map<string, number>();
  const available = new Map<string, number[]>();
  const seen = new Set<string>();
  for (const operation of operations) {
    // Each logical operation is unique; preserve all intersections and choose the highest as the default.
    if (!operation) continue;
    if (seen.has(operation.operationId)) throw new HandshakeError(`Duplicate operationId: ${operation.operationId}`);
    seen.add(operation.operationId);
    const served = servedVersions(operation);
    const shared = served
      .filter(version => supported.get(operation.operationId)?.includes(version))
      .sort((a, b) => a - b);
    available.set(operation.operationId, shared);
    if (shared.length) negotiated.set(operation.operationId, shared.at(-1)!);
  }
  return { negotiated, available };
}
