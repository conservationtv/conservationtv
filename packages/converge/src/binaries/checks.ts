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

/**
 * Runs the binary with `args` and requires its output to mention the manifest's version, so a URL pointing at the
 * wrong release is never installed. A leading `v` on either side is ignored.
 */
export function reportsVersion(args: string[] = ['--version']): Check {
  return async ({ manifest, path, signal }) => {
    const { stdout, stderr } = await run(path, args, { signal, timeout: 10_000 });
    const version = manifest.version.replace(/^v/, '').replace(/[.+]/g, '\\$&');
    const mentioned = new RegExp(`(^|[^\\w.])v?${version}(?!\\.?\\d)`);
    if (!mentioned.test(`${stdout}\n${stderr}`)) {
      const first = stdout.trim().split('\n')[0] ?? '';
      throw new Error(`Asked for ${manifest.name} ${manifest.version}, but \`${args.join(' ')}\` reports "${first}"`);
    }
  };
}
