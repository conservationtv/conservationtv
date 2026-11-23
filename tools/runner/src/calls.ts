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

/**
 * A node of a diffed call tree, as calldiff draws one: a call its parent makes, in the order it makes them, at the
 * merge base and the head. Only changed functions are opened; what they call that didn't change is shown, unopened.
 */
export const CallTreeNodeSchema = z.object({
  /** `<path>#<name>`: the same function on both sides. */
  key: z.string(),
  /** As it is called: `readSession`, `new GitHubError`, `<BotCard>`. */
  label: z.string(),
  kind: z.enum(['root', 'call', 'new', 'jsx']),
  /** Where the function is declared, on the side it is read from (the head's, unless it was removed). */
  path: z.string(),
  lines: LinesSchema,
  side: z.enum(['base', 'head']),
  /** Where the parent calls it, on that side; null at the root. */
  site: z.int().positive().nullable(),
  /** Called at both sides, only at the head, only at the merge base, or called from elsewhere than before. */
  status: z.enum(['same', 'added', 'removed', 'moved']),
  /** The function itself changed: it is opened, and its diff can be read. */
  changed: z.boolean(),
  /** It is already open further up: a call back into it. */
  recursive: z.boolean(),
  get children() {
    return z.array(CallTreeNodeSchema);
  }
});
export type CallTreeNode = z.output<typeof CallTreeNodeSchema>;

/** The diffed call tree from a changed unit nothing else changed uses: where a topic starts. */
export const CallTreeSchema = z.object({ root: z.string(), tree: CallTreeNodeSchema });
export type CallTree = z.output<typeof CallTreeSchema>;

export const CallsReportSchema = z.object({
  sha: z.string(),
  /** The merge base it was diffed against. */
  base: z.string(),
  units: z.array(ChangedUnitSchema),
  /** Symbols that call a changed unit without changing themselves: where the change is entered from. */
  callers: z.array(CallSymbolSchema),
  calls: z.array(CallSchema),
  /** Each topic's diffed call tree, by the unit it starts from. */
  trees: z.array(CallTreeSchema),
  /** Changed files it read no units from, such as those its language server could not place in a project. */
  unread: z.array(z.string())
});
export type CallsReport = z.output<typeof CallsReportSchema>;
