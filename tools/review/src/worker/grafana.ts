import { z } from 'zod';
import type { ServiceHealth, Window } from '../shared/deploys.ts';

// Grafana Cloud's traces (Tempo), read with a Viewer service account's token through Grafana's data source proxy:
// TraceQL metrics over an hour beside a deploy. Workers export their traces there through Workers Observability, each
// as `<script>` for its service name, such as `studio-api-staging`.

export interface GrafanaConfig {
  url: string;
  token: string;
}

/** Grafana Cloud's Tempo data source, as every stack names it. */
const TRACES = 'grafanacloud-traces';
/** How long a finished window's numbers are kept: they don't change once Tempo has ingested them. */
const SETTLED_SECONDS = 24 * 60 * 60;
/** How long after a window ends before it counts as settled. */
const INGESTION_MS = 10 * 60 * 1000;

/** An instant metrics query's answer: each series' labels and its one value over the range (absent when zero). */
const SeriesSchema = z.object({
  series: z
    .array(
      z.object({
        labels: z.array(z.object({ key: z.string(), value: z.record(z.string(), z.unknown()) })).optional(),
        value: z.number().nullable().optional()
      })
    )
    .optional()
});
type Series = z.output<typeof SeriesSchema>;

/** Labels Tempo adds to every series: what was computed, not what it was grouped by. */
const COMPUTED = new Set(['__name__', 'p']);

const TagValuesSchema = z.object({ tagValues: z.array(z.object({ value: z.string() })) });
type TagValues = z.output<typeof TagValuesSchema>;

/** A Grafana API answer, parsed with `schema`, and cached when it describes the settled past. */
async function grafana<T extends z.ZodType>(
  config: GrafanaConfig,
  path: string,
  settled: boolean,
  schema: T
): Promise<z.output<T>> {
  const url = `${config.url}${path}`;
  const key = new Request(url);
  const hit = settled ? await caches.default.match(key) : undefined;
  if (hit) return schema.parse(await hit.json());
  const response = await fetch(url, { headers: { authorization: `Bearer ${config.token}` } });
  if (!response.ok) throw new Error(`Grafana answered ${response.status} for ${path.split('?')[0]}.`);
  const body = await response.text();
  const parsed = schema.parse(JSON.parse(body));
  if (settled) {
    const stored = new Response(body, { headers: { 'cache-control': `max-age=${SETTLED_SECONDS}` } });
    await caches.default.put(key, stored);
  }
  return parsed;
}

/**
 * A TraceQL metrics query over exactly `[start, end]`, in seconds, as an instant query: each series' grouping label and
 * its value (Tempo leaves a zero out, and answers NaN without data).
 */
async function metric(config: GrafanaConfig, query: string, start: number, end: number): Promise<[string, number][]> {
  const params = new URLSearchParams({ q: query, start: String(start), end: String(end) });
  const settled = end * 1000 < Date.now() - INGESTION_MS;
  const path = `/api/datasources/proxy/uid/${TRACES}/api/metrics/query?${params}`;
  const parsed: Series = await grafana(config, path, settled, SeriesSchema);
  return (parsed.series ?? []).map(series => {
    // A series is named by what it was grouped by, such as an exception's message; its value is a number or nothing.
    const grouped = series.labels?.filter(label => !COMPUTED.has(label.key)) ?? [];
    const label = grouped.map(each => String(Object.values(each.value)[0] ?? '')).join(' ');
    const value = series.value ?? 0;
    return [label, Number.isFinite(value) ? value : 0];
  });
}

/** The services Tempo has seen in the past day, by name. */
export async function tracedServices(config: GrafanaConfig): Promise<string[]> {
  const now = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({ start: String(now - 86_400), end: String(now) });
  const path = `/api/datasources/proxy/uid/${TRACES}/api/v2/search/tag/resource.service.name/values?${params}`;
  const parsed: TagValues = await grafana(config, path, false, TagValuesSchema);
  return parsed.tagValues.map(each => each.value);
}

/** TraceQL's string literal. */
function quoted(text: string): string {
  return JSON.stringify(text);
}

/** How a service did over `[start, end)`. */
async function window(config: GrafanaConfig, service: string, start: number, end: number): Promise<Window> {
  const of = `resource.service.name = ${quoted(service)}`;
  const [requests, serverErrors, exceptions, p95] = await Promise.all([
    metric(config, `{ ${of} && nestedSetParent < 0 } | count_over_time()`, start, end),
    metric(config, `{ ${of} && span.http.response.status_code >= 500 } | count_over_time()`, start, end),
    metric(
      config,
      `{ ${of} && event:name = "exception" } | count_over_time() by (event.exception.message)`,
      start,
      end
    ),
    metric(config, `{ ${of} && nestedSetParent < 0 } | quantile_over_time(duration, .95)`, start, end)
  ]);
  const total = (series: [string, number][]) => series.reduce((sum, [, value]) => sum + value, 0);
  const count = total(requests);
  return {
    requests: count,
    serverErrors: total(serverErrors),
    exceptions: exceptions.map(([message, value]) => ({ message, count: value })).toSorted((a, b) => b.count - a.count),
    p95: count ? (p95[0]?.[1] ?? null) : null
  };
}

/** The service's failing or throwing traces around a deploy, in Grafana's Explore. */
function exploreUrl(config: GrafanaConfig, service: string, start: number, end: number): string {
  const query = `{ resource.service.name = ${quoted(service)} && (status = error || event:name = "exception" || span.http.response.status_code >= 500) }`;
  const panes = {
    deploy: {
      datasource: TRACES,
      queries: [{ refId: 'A', datasource: { type: 'tempo', uid: TRACES }, queryType: 'traceql', query }],
      range: { from: String(start * 1000), to: String(end * 1000) }
    }
  };
  return `${config.url}/explore?schemaVersion=1&panes=${encodeURIComponent(JSON.stringify(panes))}`;
}

/** A service in the hour before a deploy finished and the hour after (up to now), and what it newly threw. */
export async function healthAround(config: GrafanaConfig, service: string, at: number): Promise<ServiceHealth> {
  const now = Math.floor(Date.now() / 1000);
  const hour = 3600;
  const [before, after] = await Promise.all([
    window(config, service, at - hour, at),
    window(config, service, at, Math.max(at + 60, Math.min(at + hour, now)))
  ]);
  const known = new Set(before.exceptions.map(each => each.message));
  return {
    service,
    before,
    after,
    newExceptions: after.exceptions.map(each => each.message).filter(message => !known.has(message)),
    explore: exploreUrl(config, service, at - hour, at + hour)
  };
}
