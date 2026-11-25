import { z } from 'zod';

// The scenarios report's report.json (apps/studio/scenarios, src/capture/report.ts), as far as the review tool reads
// it: each shot of a page of a generated world, its images (relative to the report), what went wrong on it, and how
// far it differs from the merge base's. Uploaded with its images under `<commit>/scenarios/`. Browser-safe.

export const SCENARIOS_REPORT = 'scenarios';
export const SCENARIOS_FILE = 'report.json';

export const ShotDifferenceSchema = z.object({
  /** The base's image, copied beside the report when it differs; null when nothing changed. */
  baselineFile: z.string().nullable(),
  baselineThumb: z.string().nullable(),
  /** Changed pixels in red over a faded copy of the new shot; null when nothing changed. */
  diffFile: z.string().nullable(),
  diffThumb: z.string().nullable(),
  /** Pixels changed, and the drawn pixels of rows added or removed, once the two shots' rows are lined up: not those that only moved. */
  pixels: z.number(),
  /** Changed pixels over all of them, 0–1. */
  ratio: z.number(),
  /** The share of the shot in rows that moved but are otherwise the same, 0–1; 0 in reports from before it was. */
  moved: z.number().default(0),
  sizeChanged: z.boolean(),
  /** The page's accessibility snapshot's lines that came and went (at most 20 of each); null when not compared. */
  text: z
    .object({ added: z.array(z.string()), removed: z.array(z.string()) })
    .nullable()
    .default(null)
});
export type ShotDifference = z.output<typeof ShotDifferenceSchema>;

export const ScenarioShotSchema = z.object({
  /** Stable across runs: what the base's shot is matched by. */
  key: z.string(),
  scenario: z.string(),
  page: z.string(),
  pageTitle: z.string(),
  path: z.string(),
  theme: z.string(),
  viewport: z.string(),
  file: z.string(),
  thumb: z.string(),
  redirectedTo: z.string().nullable(),
  settled: z.boolean(),
  consoleErrors: z.array(z.string()),
  pageErrors: z.array(z.string()),
  apiFailures: z.array(z.string()),
  errorBoundary: z.boolean(),
  overflow: z.boolean(),
  order: z.number(),
  /** Null when the run wasn't compared with the base. */
  difference: ShotDifferenceSchema.nullable(),
  /** Problems found on the page, in words. */
  issues: z.array(z.string()),
  /** What the scenario meant to happen, such as an injected fault's error boundary: not issues. */
  expected: z.array(z.string())
});
export type ScenarioShot = z.output<typeof ScenarioShotSchema>;

export const ScenarioInfoSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  incidents: z.array(z.string()),
  counts: z.record(z.string(), z.number()),
  faults: z.array(z.string())
});
export type ScenarioInfo = z.output<typeof ScenarioInfoSchema>;

export const ScenarioReportSchema = z.object({
  label: z.string(),
  createdAt: z.string(),
  git: z.object({ branch: z.string(), commit: z.string(), dirty: z.boolean() }),
  /** The base's report it was compared with; null when it wasn't. */
  baseline: z.object({ label: z.string(), commit: z.string() }).nullable(),
  scenarios: z.array(ScenarioInfoSchema),
  shots: z.array(ScenarioShotSchema),
  /** Shots the base had that the head didn't take. */
  removed: z.array(z.string())
});
export type ScenarioReport = z.output<typeof ScenarioReportSchema>;
