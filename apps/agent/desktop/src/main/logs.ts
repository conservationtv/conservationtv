import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  configure,
  dispose,
  getJsonLinesFormatter,
  getTextFormatter,
  type LogRecord,
  type Sink
} from '@logtape/logtape';
import { app } from 'electron';
import type { LogLine } from '../shared/bridge.ts';

// Where the app's and the agent's logs go: one JSON object a line to a file in the OS's log folder for the app, as the
// runner writes them to the console (apps/agent/runner/src/index.ts); the latest lines to the window; and the agent's
// warnings and errors to the studio API, through the running agent's own sink.

/** How many lines the window is given when it opens. */
const KEPT_LINES = 300;

export const logFile = () => join(app.getPath('logs'), 'agent.log');

/** A record's message with its values in place, as logtape renders them, without the rest of the line. */
const messageFormatter = getTextFormatter({ format: ({ message }) => message });
const messageOf = (record: LogRecord): string => messageFormatter(record).trimEnd();

/** The latest lines, and who to tell of each new one. */
export class LogBuffer {
  private readonly lines: LogLine[] = [];
  private readonly listeners = new Set<(line: LogLine) => void>();

  readonly sink: Sink = record => {
    const line: LogLine = {
      timestamp: record.timestamp,
      level: record.level,
      category: record.category.join('.'),
      message: messageOf(record)
    };
    this.lines.push(line);
    if (this.lines.length > KEPT_LINES) this.lines.shift();
    for (const listener of this.listeners) listener(line);
  };

  latest(): LogLine[] {
    return [...this.lines];
  }

  subscribe(listener: (line: LogLine) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * Send the agent's and the app's logs to the file, `buffer`, and `studio`: the running agent's sink, which drops
 * records while none runs. Disposed by `closeLogs`.
 */
export async function configureLogs(buffer: LogBuffer, studio: Sink): Promise<void> {
  await mkdir(app.getPath('logs'), { recursive: true });
  const stream = createWriteStream(logFile(), { flags: 'a' });
  const formatter = getJsonLinesFormatter({ message: 'template', properties: 'flatten' });
  const file: Sink & Disposable = Object.assign((record: LogRecord) => void stream.write(formatter(record)), {
    [Symbol.dispose]: () => stream.end()
  });
  await configure({
    sinks: { file, window: buffer.sink, studio },
    loggers: [
      { category: 'agent', lowestLevel: 'info', sinks: ['file', 'window', 'studio'] },
      { category: 'desktop', lowestLevel: 'info', sinks: ['file', 'window'] },
      { category: ['logtape', 'meta'], lowestLevel: 'warning', sinks: ['file'] }
    ]
  });
}

export const closeLogs = dispose;
