import { getLogger } from '@logtape/logtape';
import { lt, min } from 'drizzle-orm';
import { z } from 'zod';
import type { AgentDatabase } from './database.ts';
import { logRecords, metricPoints } from './schema.ts';

// How long the agent keeps its samples and logs, and how much of its disk they may take. Every few minutes, drop
// what is older than the age allowed, then, while the database still holds more than its share, the oldest hour of
// both at a time. SQLite reuses the pages dropped rows free, so the file stops growing at about its share rather than
// shrinking back.

export interface RetentionOptions {
  /** How long samples and logs are kept. */
  maxAgeMs: number;
  /** How many bytes of rows the database may hold before the oldest are dropped, whatever their age. */
  maxBytes: number;
}

export const DEFAULT_RETENTION: RetentionOptions = {
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
  maxBytes: 1024 * 1024 * 1024
};

/** How often retention runs. */
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

/** How much is dropped at a time while the database holds more than its share. */
const PRUNE_STEP_MS = 60 * 60 * 1000;

/** The most steps one run takes, so a database far over its share catches up over several runs. */
const MAX_PRUNE_STEPS = 48;

const logger = getLogger(['agent', 'retention']);

const UsageSchema = z.object({ used: z.number() });
type Usage = z.output<typeof UsageSchema>;

/** The bytes the database's rows take: its pages, less those free for reuse. */
function usedBytes(db: AgentDatabase): number {
  const statement = db.$client.prepare(
    'SELECT (page_count - freelist_count) * page_size AS used FROM pragma_page_count, pragma_freelist_count, pragma_page_size'
  );
  const usage: Usage = UsageSchema.parse(statement.get());
  return usage.used;
}

/** The oldest sample or log line, if there is any. */
function oldest(db: AgentDatabase): number | undefined {
  const point = db
    .select({ at: min(metricPoints.observedAt) })
    .from(metricPoints)
    .get();
  const log = db
    .select({ at: min(logRecords.recordedAt) })
    .from(logRecords)
    .get();
  const times = [point?.at, log?.at].flatMap(at => (at === null || at === undefined ? [] : [at.getTime()]));
  return times.length === 0 ? undefined : Math.min(...times);
}

/** Drop every sample and log line older than `cutoff`. */
function dropBefore(db: AgentDatabase, cutoff: Date): void {
  db.delete(metricPoints).where(lt(metricPoints.observedAt, cutoff)).run();
  db.delete(logRecords).where(lt(logRecords.recordedAt, cutoff)).run();
}

/** Keeps the database within its retention, on a timer, from `start()` until `stop()`. */
export class Retention {
  private timer: ReturnType<typeof setInterval> | undefined = undefined;

  constructor(
    private readonly db: AgentDatabase,
    private readonly options: RetentionOptions
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.prune();
    this.timer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Drop what is too old, then the oldest while the database holds too much. A failure waits for the next run. */
  prune(): void {
    const { db, options } = this;
    try {
      const now = Date.now();
      dropBefore(db, new Date(now - options.maxAgeMs));
      for (let step = 0; step < MAX_PRUNE_STEPS && usedBytes(db) > options.maxBytes; step++) {
        const from = oldest(db);
        if (from === undefined) break;
        dropBefore(db, new Date(from + PRUNE_STEP_MS));
      }
    } catch (error) {
      logger.warning('Could not prune the database: {error}', { error });
    }
  }
}
