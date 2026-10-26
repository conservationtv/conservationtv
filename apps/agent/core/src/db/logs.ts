import { type LogLevel, type LogRecord, type Sink, getJsonLinesFormatter } from '@logtape/logtape';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { type AgentDatabase, useDatabase } from './database.ts';
import { z } from 'zod';
import type { LogsQuery } from '../routes/logs.ts';
import { logRecords } from './schema.ts';

// The agent's logs, kept on its disk: a logtape sink the host adds beside the console, writing each line as it is
// logged. Never shipped to the studio API; read over the agent API instead.

/** Each level, least severe first. */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warning', 'error', 'fatal'] as const satisfies LogLevel[];

/** A line's values, as JSON carries them. */
export const LogPropertiesSchema = z.record(z.string(), z.json());
export type LogProperties = z.output<typeof LogPropertiesSchema>;

/** What the JSON Lines formatters below write of a line. */
const FormattedSchema = z.object({ message: z.string(), properties: LogPropertiesSchema });
type Formatted = z.output<typeof FormattedSchema>;

// logtape's own JSON Lines formatter makes a line's values JSON as the console sink does: an error by its name, message
// and stack, a bigint as a string, a cycle cut. One renders the message with its values, the other gives its template.
const rendered = getJsonLinesFormatter({ message: 'rendered', properties: 'nest:properties' });
const template = getJsonLinesFormatter({ message: 'template', properties: 'nest:properties' });

/** A line as the database keeps it. */
function rowOf(record: LogRecord) {
  const line: Formatted = FormattedSchema.parse(JSON.parse(rendered(record)));
  const raw: Formatted = FormattedSchema.parse(JSON.parse(template(record)));
  return {
    recordedAt: new Date(record.timestamp),
    level: record.level,
    category: record.category.join('.'),
    message: line.message,
    template: raw.message,
    properties: line.properties
  };
}

/**
 * A sink writing each log line to `db`. A line it cannot write is dropped: logging the failure would come back here,
 * and the console sink beside it still has the line.
 */
export function getDatabaseSink(db: AgentDatabase): Sink {
  return record => {
    try {
      db.insert(logRecords).values(rowOf(record)).run();
    } catch {
      // Dropped; see above.
    }
  };
}

/** The agent's log lines, newest first. */
export function listLogs(query: LogsQuery) {
  const db = useDatabase();
  const levels = query.level === undefined ? undefined : LOG_LEVELS.slice(LOG_LEVELS.indexOf(query.level));
  const category = query.category;
  return db
    .select({
      id: logRecords.id,
      recordedAt: logRecords.recordedAt,
      level: logRecords.level,
      category: logRecords.category,
      message: logRecords.message,
      template: logRecords.template,
      properties: logRecords.properties
    })
    .from(logRecords)
    .where(
      and(
        query.before === undefined ? undefined : lt(logRecords.id, query.before),
        levels === undefined ? undefined : inArray(logRecords.level, levels),
        category === undefined
          ? undefined
          : or(
              eq(logRecords.category, category),
              sql`substr(${logRecords.category}, 1, ${category.length + 1}) = ${`${category}.`}`
            )
      )
    )
    .orderBy(desc(logRecords.id))
    .limit(query.limit)
    .all();
}
