import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { CallSymbol, CallsReport, ChangedUnit, Lines } from './calls.ts';
import { classify } from './classify.ts';
import { startLanguageServer, type DocumentSymbol, type LanguageServer, type Position } from './lsp.ts';

// The calls report: what the pull request changed, function by function, and who calls each, from TypeScript's own
// language server at the head. Each changed source file's symbols are listed; a top-level function, method or
// multi-line value whose lines the diff touches is a changed unit; then each unit's references are asked for, across
// the workspace, each placed in the symbol around it, and kept as uses between units or from an unchanged symbol
// into one. A reference outside any symbol is the file's own top-level code, unless it only imports or exports.

const SOURCE = /\.(?:[cm]?tsx?|jsx?)$/;
/** How many units' callers are asked for at once. */
const CONCURRENCY = 8;

/** The language server's symbol kinds, by name; only the ones a unit or caller can be. */
const kinds = new Map([
  [1, 'file'],
  [2, 'module'],
  [5, 'class'],
  [6, 'method'],
  [7, 'property'],
  [9, 'constructor'],
  [12, 'function'],
  [13, 'variable'],
  [14, 'constant']
]);
const CLASS = 5;
/** Values that are only a unit when they span lines: a function or component bound to a name, not a constant. */
const VALUES = new Set([7, 13, 14]);
const CALLABLE = new Set([6, 9, 12]);

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** Each changed file's added or changed lines at the head, from a diff without context. */
function changedLines(root: string, base: string): Map<string, Lines[]> {
  const diff = git(root, ['diff', '-U0', '--no-color', '--no-renames', '--diff-filter=AM', base, 'HEAD']);
  const files = new Map<string, Lines[]>();
  let current: Lines[] | null = null;
  for (const line of diff.split('\n')) {
    // `+++ b/<path>` starts a file; each `@@ -a,b +c,d @@` adds lines c to c+d-1 (d is 1 when left out).
    const file = line.match(/^\+\+\+ b\/(.+)$/);
    if (file?.[1]) {
      current = [];
      files.set(file[1], current);
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    const count = Number(hunk?.[2] ?? 1);
    if (hunk && current && count > 0) current.push({ start: Number(hunk[1]), end: Number(hunk[1]) + count - 1 });
  }
  return files;
}

function overlaps(a: Lines, b: Lines): boolean {
  return a.start <= b.end && b.start <= a.end;
}

function linesOf(symbol: DocumentSymbol): Lines {
  return { start: symbol.range.start.line + 1, end: symbol.range.end.line + 1 };
}

function idOf(file: string, name: string, line: number): string {
  return `${file}#${name}@${line}`;
}

/** The symbols a file is read as units from: its top-level ones, and the members of its classes. */
function candidates(symbols: readonly DocumentSymbol[]): DocumentSymbol[] {
  return symbols.flatMap(symbol => (symbol.kind === CLASS ? (symbol.children ?? []) : [symbol]));
}

function isUnit(symbol: DocumentSymbol): boolean {
  if (CALLABLE.has(symbol.kind)) return true;
  return VALUES.has(symbol.kind) && symbol.range.end.line > symbol.range.start.line;
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
  root: string;
  server: LanguageServer;
  changed: Map<string, Lines[]>;
  /** Units by their file and the line their name is on, to know a caller is one. */
  unitAt: Map<string, ChangedUnit>;
  /** Each file read so far: its lines, and its symbols once asked for. */
  files: Map<string, OpenFile>;
}

interface OpenFile {
  lines: string[];
  symbols: Promise<DocumentSymbol[]>;
}

/** A file as the server knows it: opened the first time it is needed, its symbols asked for once. */
function openFile(context: Context, file: string): OpenFile {
  const known = context.files.get(file);
  if (known) return known;
  const absolute = path.join(context.root, file);
  const text = readFileSync(absolute, 'utf8');
  context.server.open(absolute, text);
  const opened = { lines: text.split('\n'), symbols: context.server.symbols(absolute).catch(() => []) };
  context.files.set(file, opened);
  return opened;
}

/** A line that only names a symbol to import or export it, at the top of a file: a reference, but no use. */
const IMPORT_LINE = /^\s*(?:import\b|export\s*(?:\{|\*|type\b)|}\s*from\b|(?:type\s+)?[\w$]+(?:\s+as\s+[\w$]+)?,?\s*$)/;

/** The symbol a reference is in: the innermost unit candidate around its line, else the file itself. */
async function containerOf(context: Context, file: string, line: number): Promise<CallSymbol | null> {
  const opened = openFile(context, file);
  const around = candidates(await opened.symbols)
    .filter(symbol => {
      const lines = linesOf(symbol);
      return line >= lines.start && line <= lines.end;
    })
    .toSorted((a, b) => linesOf(a).end - linesOf(a).start - (linesOf(b).end - linesOf(b).start))[0];
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
  const references = await context.server.references(path.join(context.root, unit.path), at).catch(() => []);
  const sitesBy = new Map<string, Uses>();
  for (const reference of references) {
    // Each reference in this repository's own files, gathered by the symbol it is in.
    const file = path.relative(context.root, decodeURIComponent(reference.uri.replace(/^file:\/\//, '')));
    if (file.startsWith('..') || file.includes('node_modules/')) continue;
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
  const changed = changedLines(root, base);
  const sources = [...changed.keys()].filter(file => {
    if (!SOURCE.test(file) || file.endsWith('.d.ts')) return false;
    const header = readFileSync(path.join(root, file), 'utf8').split('\n', 1)[0] ?? null;
    return classify(file, header).category === 'source';
  });
  const server = await startLanguageServer(root);
  try {
    const context: Context = { root, server, changed, unitAt: new Map(), files: new Map() };
    const unread: string[] = [];
    const read = await inBatches(sources, CONCURRENCY, async file => {
      const symbols = await openFile(context, file).symbols;
      if (!symbols.length) unread.push(file);
      return unitsOf(file, symbols, changed.get(file) ?? []);
    });
    const units = read.flat();
    for (const { unit } of units) context.unitAt.set(`${unit.path}:${unit.line}`, unit);
    const found = await inBatches(units, CONCURRENCY, ({ unit, at }) => incomingTo(context, unit, at));
    const callers = new Map(found.flatMap(each => each.callers).map(caller => [caller.id, caller]));
    return {
      sha,
      base,
      units: units.map(({ unit }) => unit),
      callers: [...callers.values()],
      calls: found.flatMap(each => each.calls),
      unread
    };
  } finally {
    server.close();
  }
}
