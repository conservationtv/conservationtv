import { PgError, type ConnectConfig, type QueryMetrics } from 'drizzle-orm/postgres';
import type { OpenSpan, Tracer } from './trace.ts';

type Plugin = NonNullable<ConnectConfig['plugins']>[number];

/**
 * The statement's leading keyword (`SELECT`, `WITH`): enough to tell queries apart without any of their values. Postgres
 * reports a statement's command only when it completes, so this names the ones that fail.
 */
function operationOf(sql: string): string | undefined {
  const [keyword] = sql.trimStart().split(/\s/u, 1);
  return keyword ? keyword.toUpperCase() : undefined;
}

/** What a query did, from the driver's measurements: never its text or parameters, which may carry what a request set. */
function queryAttributes(metrics: QueryMetrics) {
  return {
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
    onQueryStart(info) {
      const span = tracer.startSpan('database.query');
      span.setAttributes({ 'db.system.name': 'postgresql', 'db.operation.name': operationOf(info.sql), ...attributes });
      return span;
    },
    onQueryEnd(state, info, metrics) {
      // SAFETY: the state is what onQueryStart returned for this query.
      const span = state as OpenSpan;
      // The server's command tag, once it has one, over the leading keyword: `WITH … INSERT` is an `INSERT`.
      span.setAttributes({
        ...queryAttributes(metrics),
        'db.operation.name': metrics.command ?? operationOf(info.sql)
      });
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
