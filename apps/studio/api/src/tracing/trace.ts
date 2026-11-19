import type { OperationRun } from '@conservationtv/versioned-api/server';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { useEnvironment } from '../env/env.ts';
import { useRequestRecord, type RequestRecord } from '../requests/record.ts';

// Tracing, through the Workers runtime's own (`ctx.tracing`), which the entrypoint hands to the environment so the rest
// of the API stays runtime-neutral. The runtime traces each invocation and its subrequests itself; this adds what only
// the API knows: a span for the operation the request was routed to, with what the request record says (the operation,
// who, where, the outcome), and inside it spans for authenticating the request, each database connection and
// transaction (named by what it is for, where that isn't simply the operation's own work), and each subject a report
// batch has judged again. Traces are sampled and leave for an outside service, so they carry IDs, never names,
// addresses or anything a request body set.

/** Attribute values a span takes; undefined ones are left out. */
export type AttributeValue = boolean | number | string | undefined;

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

/** Run `run` in a span named `name`, with `attributes`; `run` is given the span, to describe what it found. */
export function traced<T>(name: string, attributes: Record<string, AttributeValue>, run: (span: TraceSpan) => T): T {
  const environment = useEnvironment();
  return environment.tracing.enterSpan(name, span => {
    span.setAttributes(attributes);
    return run(span);
  });
}

/** What the request record says about the operation, in the API's own namespace beside the runtime's HTTP attributes. */
function operationAttributes(record: RequestRecord) {
  const { operation, actor, organisationId, failure, accessChanges } = record;
  const targets = Object.entries(operation?.targets ?? {}).map(([name, id]) => [`studio.target.${name}`, id]);
  const changes = accessChanges.map(
    ({ change, assignment }) =>
      `${change} ${assignment.role} to ${assignment.principalKind}:${assignment.principalId} at ${assignment.scopeName}:${assignment.scopeId}`
  );
  return {
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

/** An error status for a server failure: a client's own failure is not the server's error. */
function describeOutcome(span: TraceSpan, status: number, failure: string | undefined) {
  if (status >= 500) span.setStatus({ code: 'error', message: failure });
}

/**
 * Run an operation's handlers in a span of its own, a child of the request's, named by the operation's ID: its
 * authentication, validation, handler and audit entry, and the transactions they run, are all inside it. Described
 * from the request record once they have been handled, when the record knows who it ran as and how it ended; the
 * error handler has rendered any failure by then, so the status is the one sent.
 */
export async function traceOperation(c: Context, operationId: string, run: OperationRun) {
  const environment = useEnvironment();
  return environment.tracing.enterSpan(operationId, async span => {
    try {
      return await run();
    } finally {
      const record = useRequestRecord();
      span.setAttributes(operationAttributes(record));
      describeOutcome(span, c.res.status, record.failure);
    }
  });
}

/**
 * Describe the request on its span once it has been handled, as HTTP server spans are: named by its route, with an
 * error status for a server failure. What the operation did is on the operation's own span (`traceOperation`). After
 * `recordRequest`, so the record is there; the error handler has rendered any failure by the time `next` returns, so
 * the status is the one sent.
 */
export const traceRequest = createMiddleware(async (c, next) => {
  await next();
  const environment = useEnvironment();
  const span = environment.tracing.getActiveSpan();
  if (!span) return;
  const record = useRequestRecord();
  const { operation, failure } = record;
  if (operation) {
    span.updateName(`${operation.method} ${operation.path}`);
    span.setAttributes({ 'http.route': operation.path });
  }
  describeOutcome(span, c.res.status, failure);
});
