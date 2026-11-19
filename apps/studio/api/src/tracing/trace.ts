import { createMiddleware } from 'hono/factory';
import { useEnvironment } from '../env/env.ts';
import { useRequestRecord, type RequestRecord } from '../requests/record.ts';

// Tracing, through the Workers runtime's own (`ctx.tracing`), which the entrypoint hands to the environment so the rest
// of the API stays runtime-neutral. The runtime traces each invocation and its subrequests itself; this adds what only
// the API knows: on the request's span, what the request record says (the operation, who, where, the outcome), and a
// span for each transaction. Traces are sampled and leave for an outside service, so they carry IDs, never names,
// addresses or anything a request body set.

/** Attribute values a span takes; undefined ones are left out. */
type AttributeValue = boolean | number | string | undefined;

/** A span's outcome: `error` for a failure, with what went wrong. */
export interface SpanStatus {
  code: 'unset' | 'ok' | 'error';
  message?: string;
}

/** Where a span is: the IDs the runtime's trace views and exports know it by. */
export interface SpanIds {
  traceId: string;
  spanId: string;
}

/** A span, as the runtime's tracing gives it: only what this API uses. */
export interface TraceSpan {
  setAttributes(attributes: Record<string, AttributeValue>): void;
  setStatus(status: SpanStatus): void;
  updateName(name: string): void;
  /**
   * False when the Worker's observability is off. It does not reflect head sampling, which this Worker leaves at every
   * request (apps/studio/infrastructure).
   */
  readonly isTraced: boolean;
  /** The span's IDs, as trace views and exports know it, and as the invocation's logs carry them; zeros when untraced. */
  spanContext(): SpanIds;
}

/** The runtime's tracing (`ctx.tracing`), as this API uses it. */
export interface Tracer {
  /** Run `run` in a new child span of the active one, which ends when `run` returns or its promise settles. */
  enterSpan<T>(name: string, run: (span: TraceSpan) => T): T;
  /** The innermost active span: the invocation's own when no other is open. */
  getActiveSpan(): TraceSpan | undefined;
}

/** The ID of the trace the request is in, to find it from elsewhere (an audit entry); undefined if it is not traced. */
export function currentTraceId(): string | undefined {
  const environment = useEnvironment();
  const span = environment.tracing.getActiveSpan();
  if (!span?.isTraced) return undefined;
  const context = span.spanContext();
  return context.traceId;
}

/** Run `run` in a span named `name`, with `attributes`. */
export function traced<T>(name: string, attributes: Record<string, AttributeValue>, run: () => T): T {
  const environment = useEnvironment();
  return environment.tracing.enterSpan(name, span => {
    span.setAttributes(attributes);
    return run();
  });
}

/** The request record's attributes, in the API's own namespace beside the runtime's HTTP ones. */
function recordAttributes(record: RequestRecord) {
  const { operation, actor, organisationId, failure, accessChanges } = record;
  const targets = Object.entries(operation?.targets ?? {}).map(([name, id]) => [`studio.target.${name}`, id]);
  const changes = accessChanges.map(
    ({ change, assignment }) =>
      `${change} ${assignment.role} to ${assignment.principalKind}:${assignment.principalId} at ${assignment.scopeName}:${assignment.scopeId}`
  );
  return {
    'http.route': operation?.path,
    'studio.operation.id': operation?.id,
    'studio.operation.version': operation?.version,
    'studio.principal.kind': actor?.principal.kind,
    'studio.principal.id': actor === undefined ? undefined : String(actor.principal.id),
    'studio.device.kind': actor?.deviceKind,
    'studio.organisation.id': organisationId,
    'studio.failure': failure,
    'studio.access.changes': changes.length > 0 ? changes.join('; ') : undefined,
    ...Object.fromEntries(targets)
  };
}

/**
 * Describe the request on its span once it has been handled: named by its route, as HTTP server spans are, with the
 * request record's attributes, and an error status for a server failure (a client's own failure is not the server's
 * error). After `recordRequest`, so the record is there; the error handler has rendered any failure by the time `next`
 * returns, so the status is the one sent.
 */
export const traceRequest = createMiddleware(async (c, next) => {
  await next();
  const environment = useEnvironment();
  const span = environment.tracing.getActiveSpan();
  if (!span) return;
  const record = useRequestRecord();
  const { operation, failure } = record;
  if (operation) span.updateName(`${operation.method} ${operation.path}`);
  span.setAttributes(recordAttributes(record));
  if (c.res.status >= 500) span.setStatus({ code: 'error', message: failure });
});
