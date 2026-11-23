import { z } from 'zod';

// What a signoff run leaves for the review tool, under `<commit>/<signoff>/` in its results bucket: `log.txt`, any
// report it wrote, and `result.json` last, which marks the run complete. Browser-safe: the review tool's app parses it.

export const RESULT_FILE = 'result.json';
export const LOG_FILE = 'log.txt';

export const RunResultSchema = z.object({
  signoff: z.string(),
  /** The commit it ran at. */
  sha: z.string(),
  /** Failed when a command failed, or when the run changed files the commit has. */
  state: z.enum(['success', 'failure']),
  /** Why it failed, in a line. */
  reason: z.string().nullable(),
  startedAt: z.iso.datetime(),
  durationMs: z.int().nonnegative(),
  /** Who ran it, by GitHub login, as the review tool checked their token. */
  ranBy: z.string(),
  /** The other files it uploaded beside the log, by their path under the run. */
  files: z.array(z.string())
});
export type RunResult = z.output<typeof RunResultSchema>;

/** A commit's runs, as the review tool lists them: the latest of each signoff. */
export const RunResultsSchema = z.array(RunResultSchema);
export type RunResults = z.output<typeof RunResultsSchema>;
