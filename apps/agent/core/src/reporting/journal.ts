import type { LogRecord, Sink } from '@logtape/logtape';
import { createStore } from '@conservationtv/store';
import { z } from 'zod';
import type { MetricReporter, PendingReport } from './reporter.ts';

// What the agent did and said, reported to the studio API beside what it measured: events (a process started or died,
// a spec was applied, a publisher dropped, a camera stopped answering) and its own warnings and errors as logs. Metrics
// say how much flowed; these say why it stopped, on the same timeline. About the agent's device unless said otherwise.
//
// Entries are kept and submitted every few seconds through the agent's reporter. A submission that fails is retried
// with the next, the oldest dropped beyond `MAX_PENDING`. The same log line said again before it is submitted is
// counted on the first rather than sent again, so an error in a loop is one report that says how often.

/** How often what is pending is submitted. */
const FLUSH_MS = 5_000;

/** The most entries kept for the next submission. */
const MAX_PENDING = 500;

/** What an event says beyond its type: flat values, as the studio API stores them. */
export type EventData = Record<string, Flat>;

/** The log levels reported: what went wrong, or may have. */
const REPORTED_LEVELS = new Set(['warning', 'error', 'fatal']);

/** A log line already pending, and how often it has been said since. */
interface Repeated {
  report: PendingLog;
  count: number;
}
type PendingLog = Extract<PendingReport, Record<'kind', 'log'>>;

/** A value an event's data or a log's context keeps as it is. */
const FlatSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
type Flat = z.output<typeof FlatSchema>;

/** A value a log record carries: whatever its caller passed. */
type LogValue = LogRecord['properties'][string];

/** A log record's value as its context keeps it: as it is when flat, an error's message, and anything else as JSON. */
function flat(value: LogValue): Flat {
  const kept = FlatSchema.safeParse(value ?? null);
  if (kept.success) return kept.data;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value).slice(0, 2_000);
  } catch {
    return String(value);
  }
}

/** A log record's message, its values in place. */
function rendered(record: LogRecord): string {
  return record.message.map(part => String(flat(part))).join('');
}

/** A log record's message as it was written, its values still named: the same for every record of its kind. */
function templateOf({ rawMessage }: LogRecord): string {
  return Array.isArray(rawMessage) ? rawMessage.join('{}') : String(rawMessage);
}

/** The agent's events and logs, pending submission. */
export class Journal {
  private pending: PendingReport[] = [];
  private readonly repeated = new Map<string, Repeated>();
  private timer: ReturnType<typeof setInterval> | undefined = undefined;
  private flushing: Promise<void> | undefined = undefined;

  constructor(private readonly reporter: MetricReporter) {}

  /** Start submitting what is pending every few seconds. */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref();
  }

  /** Something the agent did or saw happen, now: about `subjectId`, or the agent's device without one. */
  event(type: string, data: EventData = {}, subjectId?: string): void {
    const now = new Date();
    this.add({ kind: 'event', subjectId, observedAt: now.toISOString(), payload: { type, data } });
  }

  /** A logtape sink: the agent's warnings and errors, as log reports about its device. */
  readonly sink: Sink = record => {
    if (!REPORTED_LEVELS.has(record.level)) return;
    // What the journal's own submissions log never goes back into it.
    if (record.category.includes('journal')) return;
    const key = `${record.level} ${record.category.join('.')} ${templateOf(record)}`;
    const known = this.repeated.get(key);
    if (known !== undefined) {
      known.count++;
      known.report.payload.context = { ...known.report.payload.context, repeated: known.count };
      return;
    }
    const properties = Object.entries(record.properties).map(([name, value]) => [name, flat(value)]);
    const context = { ...Object.fromEntries(properties), logger: record.category.join('.') };
    const at = new Date(record.timestamp);
    const report: PendingLog = {
      kind: 'log',
      subjectId: undefined,
      observedAt: at.toISOString(),
      payload: { level: record.level, message: rendered(record).slice(0, 16_000), context }
    };
    this.repeated.set(key, { report, count: 1 });
    this.add(report);
  };

  /** Submit what is pending. A failure keeps it for the next time; it never throws. */
  flush(): Promise<void> {
    if (this.flushing === undefined) this.flushing = this.submit().finally(() => (this.flushing = undefined));
    return this.flushing;
  }

  /** Stop the timer, and submit what is pending one last time. */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }

  private add(report: PendingReport): void {
    this.pending = [...this.pending, report].slice(-MAX_PENDING);
  }

  private async submit(): Promise<void> {
    if (this.pending.length === 0) return;
    const sent = new Set(this.pending);
    // Lines said again from here on are new reports: these are on their way.
    this.repeated.clear();
    try {
      await this.reporter.send([...sent]);
      this.pending = this.pending.filter(report => !sent.has(report));
    } catch {
      // Kept for the next submission. Not logged: a failing studio API would otherwise fill the journal with itself.
    }
  }
}

/** The agent's journal. The agent supplies it on start; its runtimes write to it with `useJournal()`. */
export const [withJournal, useJournal] = createStore<Journal>('journal');
