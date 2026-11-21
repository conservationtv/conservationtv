import { PgError, type ConnectConfig, type QueryMetrics } from 'drizzle-orm/postgres';
import type { OpenSpan, Tracer } from './trace.ts';

type Plugin = NonNullable<ConnectConfig['plugins']>[number];

/** What a query did, from the driver's measurements: never its text or parameters, which may carry what a request set. */
function queryAttributes(metrics: QueryMetrics) {
  return {
    'db.operation.name': metrics.command ?? undefined,
    'db.response.returned_rows': metrics.rowCount ?? undefined,
    'db.client.response.body.size': metrics.bytesReceived,
    'postgres.prepared': metrics.prepared,
    'postgres.bytes_sent': metrics.bytesSent,
    'postgres.queue_wait_ms': metrics.queueWait,
    'postgres.ttfb_ms': metrics.ttfb,
    'postgres.download_ms': metrics.download,
    'postgres.decode_ms': metrics.decode
  };
}

/**
 * A span for each query on a connection, through the driver's plugin hooks. The span starts when the driver writes the
 * query, as a child of the span active then (the transaction's), and ends when its result or error arrives. A failure
 * is described by its SQLSTATE alone: a database's message can quote the values it refused.
 */
export function traceQueries(tracer: Tracer, attributes: Record<string, string>): Plugin {
  return {
    name: 'studio-tracing',
    onQueryStart() {
      const span = tracer.startSpan('database.query');
      span.setAttributes({ 'db.system.name': 'postgresql', ...attributes });
      return span;
    },
    onQueryEnd(state, _info, metrics) {
      // SAFETY: the state is what onQueryStart returned for this query.
      const span = state as OpenSpan;
      span.setAttributes(queryAttributes(metrics));
      span.end();
    },
    onQueryError(state, _info, error, metrics) {
      // SAFETY: as in onQueryEnd.
      const span = state as OpenSpan;
      const code = error instanceof PgError ? error.code : undefined;
      span.setAttributes({ ...queryAttributes(metrics), 'db.response.status_code': code });
      span.setStatus({ code: 'error', message: code ?? error.name });
      span.end();
    }
  };
}
