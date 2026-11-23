import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Lines } from './calls.ts';
import { startLanguageServer, type DocumentSymbol, type LanguageServer, type Location } from './lsp.ts';

// A checkout as TypeScript's language server reads it, for the calls report: its files, opened as they are first
// needed, their symbols, and where a reference or definition sits among them. The report reads the head this way, and
// the merge base in a worktree of its own.

/** The language server's symbol kinds, by name; only the ones a unit or caller can be. */
export const kinds = new Map([
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

export function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/**
 * A worktree of a commit beside the checkout at `root`, sharing its installed dependencies, so the language server
 * resolves its imports as it does the checkout's. Remove it with `git worktree remove --force`.
 */
export function worktreeAt(root: string, commit: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'review-worktree-'));
  git(root, ['worktree', 'add', '--detach', '--quiet', dir, commit]);
  const packages = git(root, ['ls-files', '--', 'package.json', '*/package.json']).split('\n').filter(Boolean);
  for (const manifest of packages) {
    // Each package's node_modules, where both checkouts have the package.
    const folder = path.dirname(manifest);
    const installed = path.join(root, folder, 'node_modules');
    const into = path.join(dir, folder);
    if (existsSync(installed) && existsSync(into) && !existsSync(path.join(into, 'node_modules'))) {
      symlinkSync(installed, path.join(into, 'node_modules'));
    }
  }
  return dir;
}

export function overlaps(a: Lines, b: Lines): boolean {
  return a.start <= b.end && b.start <= a.end;
}

export function linesOf(symbol: DocumentSymbol): Lines {
  return { start: symbol.range.start.line + 1, end: symbol.range.end.line + 1 };
}

export function idOf(file: string, name: string, line: number): string {
  return `${file}#${name}@${line}`;
}

/** The symbols a file is read as units from: its top-level ones, and the members of its classes. */
export function candidates(symbols: readonly DocumentSymbol[]): DocumentSymbol[] {
  return symbols.flatMap(symbol => (symbol.kind === CLASS ? (symbol.children ?? []) : [symbol]));
}

export function isUnit(symbol: DocumentSymbol): boolean {
  if (CALLABLE.has(symbol.kind)) return true;
  return VALUES.has(symbol.kind) && symbol.range.end.line > symbol.range.start.line;
}

export interface OpenFile {
  text: string;
  lines: string[];
  symbols: Promise<DocumentSymbol[]>;
}

export interface Workspace {
  root: string;
  server: LanguageServer;
  /** A file by its path in the repository, opened with the server the first time it is asked for. */
  open(file: string): OpenFile;
  /** The innermost unit candidate around a line of a file, if any. */
  around(file: string, line: number): Promise<DocumentSymbol | null>;
  /** A location the server answered with as a path in the repository, or null outside it or in a dependency. */
  pathOf(location: Location): string | null;
  close(): void;
}

/** Starts a language server on the checkout at `root`. */
export async function openWorkspace(root: string): Promise<Workspace> {
  const server = await startLanguageServer(root);
  const files = new Map<string, OpenFile>();
  const open = (file: string): OpenFile => {
    const known = files.get(file);
    if (known) return known;
    const absolute = path.join(root, file);
    const text = readFileSync(absolute, 'utf8');
    server.open(absolute, text);
    const opened = { text, lines: text.split('\n'), symbols: server.symbols(absolute).catch(() => []) };
    files.set(file, opened);
    return opened;
  };
  return {
    root,
    server,
    open,
    async around(file, line) {
      const symbols = candidates(await open(file).symbols).filter(symbol => {
        const lines = linesOf(symbol);
        return line >= lines.start && line <= lines.end;
      });
      const size = (symbol: DocumentSymbol) => symbol.range.end.line - symbol.range.start.line;
      return symbols.toSorted((a, b) => size(a) - size(b))[0] ?? null;
    },
    pathOf(location) {
      const file = path.relative(root, decodeURIComponent(location.uri.replace(/^file:\/\//, '')));
      if (file.startsWith('..') || file.includes('node_modules/') || file.endsWith('.d.ts')) return null;
      return file;
    },
    close() {
      server.close();
    }
  };
}
