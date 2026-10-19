import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Manifest } from './manifest.ts';

const run = promisify(execFile);

/** An unpacked binary not yet installed: a check can still turn it away. */
export interface Candidate {
  manifest: Manifest;
  /** The executable, ready to run. */
  path: string;
  signal: AbortSignal;
}

/** Throws if the candidate shouldn't be installed. */
export type Check = (candidate: Candidate) => Promise<void>;

export interface ReportsVersionOptions {
  /**
   * How long the binary has to answer, in milliseconds. 30 seconds by default: some binaries are slow to start every
   * time (yt-dlp's single-file build unpacks itself on each run), and macOS scans a new binary the first time it runs.
   */
  timeout?: number;
}

/**
 * Runs the binary with `args` and requires its output to mention the manifest's version, so a URL pointing at the
 * wrong release is never installed. The version may follow a letter (`go1.27.2`, `v1.21.2`, `jq-1.8.2`) but not be
 * part of a longer version (`1.21.20`, `11.21.2`). The manifest's version must be the one the binary reports, which
 * isn't always the release's tag: rust-analyzer's releases are tagged by date.
 */
export function reportsVersion(args: string[] = ['--version'], options: ReportsVersionOptions = {}): Check {
  return async ({ manifest, path, signal }) => {
    const timeout = options.timeout ?? 30_000;
    const { stdout, stderr } = await run(path, args, { signal, timeout }).catch((error: Error) => {
      // Killed, but not aborted: it ran out of time, which execFile reports only as "Command failed".
      const timedOut = 'killed' in error && error.killed === true && !signal.aborted;
      const reason = timedOut ? `no answer within ${timeout / 1000}s` : error.message;
      throw new Error(`Running ${manifest.name} ${args.join(' ')} failed: ${reason}`, { cause: error });
    });
    const version = manifest.version.replace(/^v/, '').replace(/[.+]/g, '\\$&');
    const mentioned = new RegExp(`(?<![\\d.])${version}(?!\\.?\\d)`);
    if (!mentioned.test(`${stdout}\n${stderr}`)) {
      const first = stdout.trim().split('\n')[0] ?? '';
      throw new Error(`Asked for ${manifest.name} ${manifest.version}, but \`${args.join(' ')}\` reports "${first}"`);
    }
  };
}
