import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { CallSymbol, CallsReport, ChangedUnit, Lines } from './calls.ts';
import { callTrees } from './call-trees.ts';
import { classify } from './classify.ts';
import type { DocumentSymbol, Position } from './lsp.ts';
import { candidates, git, idOf, isUnit, kinds, linesOf, openWorkspace, overlaps, type Workspace } from './workspace.ts';

// The calls report: what the pull request changed, function by function, and who calls each, from TypeScript's own
// language server at the head. Each changed source file's symbols are listed; a top-level function, method or
// multi-line value whose lines the diff touches is a changed unit; then each unit's references are asked for, across
// the workspace, each placed in the symbol around it, and kept as uses between units or from an unchanged symbol
// into one. A reference outside any symbol is the file's own top-level code, unless it only imports or exports.

const SOURCE = /\.(?:[cm]?tsx?|jsx?)$/;
/** How many units' callers are asked for at once. */
const CONCURRENCY = 8;

/** What a diff without context changed: lines added or changed at the head, and removed or changed at the base. */
export interface ChangedLines {
  head: Map<string, Lines[]>;
  base: Map<string, Lines[]>;
}

/** A diff's file header (`--- a/<path>`, `+++ b/<path>`): which side, and its path, or null for `/dev/null`. */
function fileHeader(line: string): ['base' | 'head', string | null] | null {
  const match = line.match(/^(---|\+\+\+) (?:[ab]\/(.+)|\/dev\/null)$/);
  if (!match) return null;
  return [match[1] === '---' ? 'base' : 'head', match[2] ?? null];
}

/** A hunk's header, `@@ -a,b +c,d @@`: the lines it changes on each side (b and d are 1 when left out). */
function hunkHeader(line: string): Record<'base' | 'head', Lines | null> | null {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) return null;
  const span = (start: string | undefined, count: string | undefined): Lines | null => {
    const length = Number(count ?? 1);
    return length > 0 ? { start: Number(start), end: Number(start) + length - 1 } : null;
  };
  return { base: span(match[1], match[2]), head: span(match[3], match[4]) };
}

/** The list of lines each side of the file being read adds to: none for a side the file is missing from. */
interface Reading {
  base: Lines[] | null;
  head: Lines[] | null;
}

/** A file header starts a side's list of lines, kept by its path; a side the file is missing from gets none. */
function startFile(side: 'base' | 'head', path: string | null, sides: ChangedLines, current: Reading): void {
  const lines: Lines[] | null = path ? [] : null;
  current[side] = lines;
  if (path && lines) sides[side].set(path, lines);
}

/** One line of the diff: a file header, a hunk adding to both sides' lists, or a line of a hunk, which is skipped. */
function readLine(line: string, sides: ChangedLines, current: Reading): void {
  const file = fileHeader(line);
  if (file) return startFile(file[0], file[1], sides, current);
  const hunk = hunkHeader(line);
  if (hunk?.base) current.base?.push(hunk.base);
  if (hunk?.head) current.head?.push(hunk.head);
}

/** Each changed file's changed lines on both sides, from a diff without context. */
function changedLines(root: string, base: string): ChangedLines {
  const diff = git(root, ['diff', '-U0', '--no-color', '--no-renames', '--diff-filter=AMD', base, 'HEAD']);
  const sides: ChangedLines = { head: new Map(), base: new Map() };
  const current: Reading = { base: null, head: null };
  for (const line of diff.split('\n')) readLine(line, sides, current);
  return sides;
}

/** A changed unit, and where its name is, to ask for its references from. */
interface Found {
  unit: ChangedUnit;
  at: Position;
}

/** A file's changed units: its unit symbols whose lines the diff touches, added when it added all of them. */
function unitsOf(file: string, symbols: readonly DocumentSymbol[], changed: readonly Lines[]): Found[] {
  return candidates(symbols)
    .filter(isUnit)
    .flatMap((symbol): Found[] => {
      const lines = linesOf(symbol);
      const touched = changed.filter(range => overlaps(range, lines));
      if (!touched.length) return [];
      const whole = touched.some(range => range.start <= lines.start && range.end >= lines.end);
      const line = symbol.selectionRange.start.line + 1;
      const unit: ChangedUnit = {
        id: idOf(file, symbol.name, line),
        name: symbol.name,
        kind: kinds.get(symbol.kind) ?? 'symbol',
        path: file,
        lines,
        line,
        status: whole ? 'added' : 'changed',
        changed: touched.map(range => ({
          start: Math.max(range.start, lines.start),
          end: Math.min(range.end, lines.end)
        }))
      };
      return [{ unit, at: symbol.selectionRange.start }];
    });
}

/** Runs `task` over `items`, `limit` at a time. */
async function inBatches<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += limit) {
    results.push(...(await Promise.all(items.slice(index, index + limit).map(task))));
  }
  return results;
}

interface Context {
  workspace: Workspace;
  changed: Map<string, Lines[]>;
  /** Units by their file and the line their name is on, to know a caller is one. */
  unitAt: Map<string, ChangedUnit>;
}

/** A line that only names a symbol to import or export it, at the top of a file: a reference, but no use. */
const IMPORT_LINE = /^\s*(?:import\b|export\s*(?:\{|\*|type\b)|}\s*from\b|(?:type\s+)?[\w$]+(?:\s+as\s+[\w$]+)?,?\s*$)/;

/** The symbol a reference is in: the innermost unit candidate around its line, else the file itself. */
async function containerOf(context: Context, file: string, line: number): Promise<CallSymbol | null> {
  const opened = context.workspace.open(file);
  const around = await context.workspace.around(file, line);
  if (around) {
    const at = around.selectionRange.start.line + 1;
    const unit = context.unitAt.get(`${file}:${at}`);
    if (unit) return unit;
    const kind = kinds.get(around.kind) ?? 'symbol';
    return { id: idOf(file, around.name, at), name: around.name, kind, path: file, lines: linesOf(around), line: at };
  }
  if (IMPORT_LINE.test(opened.lines[line - 1] ?? '')) return null;
  const name = path.basename(file);
  return {
    id: idOf(file, name, 1),
    name,
    kind: 'file',
    path: file,
    lines: { start: 1, end: opened.lines.length },
    line: 1
  };
}

/** Where one symbol uses a unit. */
interface Uses {
  caller: CallSymbol;
  lines: Set<number>;
}

interface Incoming {
  callers: CallSymbol[];
  calls: CallsReport['calls'];
}

/** Who uses a unit, and where: each site new when the pull request changed its line. */
async function incomingTo(context: Context, unit: ChangedUnit, at: Position): Promise<Incoming> {
  const { workspace } = context;
  const references = await workspace.server.references(path.join(workspace.root, unit.path), at).catch(() => []);
  const sitesBy = new Map<string, Uses>();
  for (const reference of references) {
    // Each reference in this repository's own files, gathered by the symbol it is in.
    const file = workspace.pathOf(reference);
    if (!file) continue;
    const line = reference.range.start.line + 1;
    const caller = await containerOf(context, file, line);
    if (!caller || caller.id === unit.id) continue;
    const entry = sitesBy.get(caller.id) ?? { caller, lines: new Set<number>() };
    entry.lines.add(line);
    sitesBy.set(caller.id, entry);
  }
  const found = [...sitesBy.values()];
  return {
    callers: found.map(({ caller }) => caller).filter(caller => !('status' in caller)),
    calls: found.map(({ caller, lines }) => {
      const added = context.changed.get(caller.path) ?? [];
      const sites = [...lines].map(line => ({
        line,
        new: added.some(range => line >= range.start && line <= range.end)
      }));
      return { from: caller.id, to: unit.id, sites };
    })
  };
}

/** The calls report of the checked-out commit against `base`, the pull request's merge base. */
export async function callsReport(root: string, sha: string, base: string): Promise<CallsReport> {
  const lines = changedLines(root, base);
  const changed = lines.head;
  const sources = [...changed.keys()].filter(file => {
    if (!SOURCE.test(file) || file.endsWith('.d.ts')) return false;
    const header = readFileSync(path.join(root, file), 'utf8').split('\n', 1)[0] ?? null;
    return classify(file, header).category === 'source';
  });
  const workspace = await openWorkspace(root);
  try {
    const context: Context = { workspace, changed, unitAt: new Map() };
    const unread: string[] = [];
    const read = await inBatches(sources, CONCURRENCY, async file => {
      const symbols = await workspace.open(file).symbols;
      if (!symbols.length) unread.push(file);
      return unitsOf(file, symbols, changed.get(file) ?? []);
    });
    const units = read.flat();
    for (const { unit } of units) context.unitAt.set(`${unit.path}:${unit.line}`, unit);
    const found = await inBatches(units, CONCURRENCY, ({ unit, at }) => incomingTo(context, unit, at));
    const callers = new Map(found.flatMap(each => each.callers).map(caller => [caller.id, caller]));
    const calls = found.flatMap(each => each.calls);
    const changedUnits = units.map(({ unit }) => unit);
    // A tree starts at each unit no other changed unit uses, as a topic does.
    const unitIds = new Set(changedUnits.map(unit => unit.id));
    const usedByUnits = new Set(calls.filter(call => unitIds.has(call.from)).map(call => call.to));
    const roots = changedUnits.filter(unit => !usedByUnits.has(unit.id));
    const trees = await callTrees({ root, base, head: workspace, units: changedUnits, roots, baseLines: lines.base });
    return { sha, base, units: changedUnits, callers: [...callers.values()], calls, trees, unread };
  } finally {
    workspace.close();
  }
}
