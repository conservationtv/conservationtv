import { z } from 'zod';

// The calls report (src/report-calls.ts): the functions a pull request changed and the calls between them, read by
// TypeScript's own language server at the head commit, so calls through imports, re-exports, renames and methods are
// followed as the compiler resolves them. Uploaded as `calls.json` under `<commit>/calls/`. Browser-safe: the review
// tool parses it.

export const CALLS_REPORT = 'calls';
export const CALLS_FILE = 'calls.json';

/** A line range in a file at the head commit, 1-based and inclusive. */
export const LinesSchema = z.object({ start: z.int().positive(), end: z.int().positive() });
export type Lines = z.output<typeof LinesSchema>;

export const CallSymbolSchema = z.object({
  /** `<path>#<name>@<line>`: stable within the report. */
  id: z.string(),
  name: z.string(),
  /** The language server's kind for it: function, method, class, variable and so on. */
  kind: z.string(),
  path: z.string(),
  /** Where it is declared, whole. */
  lines: LinesSchema,
  /** Where its name is. */
  line: z.int().positive()
});
export type CallSymbol = z.output<typeof CallSymbolSchema>;

/** A function the pull request added or changed: some of its lines are in the diff. */
export const ChangedUnitSchema = CallSymbolSchema.extend({
  status: z.enum(['added', 'changed']),
  /** Its lines the pull request added or changed. */
  changed: z.array(LinesSchema)
});
export type ChangedUnit = z.output<typeof ChangedUnitSchema>;

/** A call from one symbol into a changed one, at each place the caller makes it. */
export const CallSchema = z.object({
  from: z.string(),
  to: z.string(),
  sites: z.array(
    z.object({
      line: z.int().positive(),
      /** The call's line is one the pull request added or changed. */
      new: z.boolean()
    })
  )
});
export type Call = z.output<typeof CallSchema>;

export const CallsReportSchema = z.object({
  sha: z.string(),
  /** The merge base it was diffed against. */
  base: z.string(),
  units: z.array(ChangedUnitSchema),
  /** Symbols that call a changed unit without changing themselves: where the change is entered from. */
  callers: z.array(CallSymbolSchema),
  calls: z.array(CallSchema),
  /** Changed files it read no units from, such as those its language server could not place in a project. */
  unread: z.array(z.string())
});
export type CallsReport = z.output<typeof CallsReportSchema>;
