import type { Category, ContractChange, Review, ReviewFile } from '../shared/review.ts';

// A pull request read in the order it was made: the source code, the migrations and contracts that follow from it,
// then what generators wrote from those. Each chapter says what to look for in it.

export type ChapterId = 'code' | 'schema' | 'api' | 'generated' | 'dependencies';

export interface Chapter {
  id: ChapterId;
  title: string;
  files: ReviewFile[];
}

const chapterOf = {
  source: 'code',
  migration: 'schema',
  contract: 'api',
  generated: 'generated',
  lockfile: 'dependencies'
} satisfies Record<Category, ChapterId>;

const titles = {
  code: 'Source code',
  schema: 'Database',
  api: 'API contract',
  generated: 'Generated from it',
  dependencies: 'Dependencies'
} satisfies Record<ChapterId, string>;

export const chapterIds: readonly ChapterId[] = ['code', 'schema', 'api', 'generated', 'dependencies'];

export function isChapterId(value: string | undefined): value is ChapterId {
  return chapterIds.some(id => id === value);
}

/** The chapters this pull request has, in reading order; the API chapter whenever an operation changed. */
export function chaptersOf(review: Review): Chapter[] {
  return chapterIds
    .map(id => ({
      id,
      title: titles[id],
      files: review.files
        .filter(file => chapterOf[file.category] === id)
        .toSorted((a, b) => a.path.localeCompare(b.path))
    }))
    .filter(chapter => chapter.files.length > 0 || (chapter.id === 'api' && review.contracts.length > 0));
}

/** The hunks of a patch that `keep` accepts, as a patch of their own; null when none are. */
export function keepHunks(patch: string, keep: (hunk: string) => boolean): string | null {
  const hunks = patch.split(/\n(?=@@ )/);
  const kept = hunks.filter(keep);
  return kept.length ? kept.join('\n') : null;
}

/** `organisations.cameras.create@1` as its id and version. */
export function operationParts(operation: string): [string, number] {
  const at = operation.lastIndexOf('@');
  return [operation.slice(0, at), Number(operation.slice(at + 1))];
}

/** Letters and digits only, lower-cased: how hey-api's names for an operation, in any case, still contain its id. */
function letters(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const VERSION_FOLDER = /\/versions\/([^/]+)-v(\d+)\//;

export type ConnectionRole = 'route' | 'contract' | 'generated';

export interface Connection {
  file: ReviewFile;
  role: ConnectionRole;
  /** The hunks that concern the operation, or the whole patch when the whole file does. */
  patch: string | null;
  partial: boolean;
}

/** What one operation is called, to find it with. */
interface Target {
  id: string;
  version: number;
  document: string;
  /** Its id in letters and digits only. */
  name: string;
}

function quotes(hunk: string, target: Target): boolean {
  return hunk.includes(`'${target.id}'`) || hunk.includes(`"${target.id}"`);
}

/** Generated output: a versioned folder is its operation version's alone; elsewhere, the hunks naming it. */
function generatedConnection(file: ReviewFile, patch: string, target: Target): Connection[] {
  const folder = file.path.match(VERSION_FOLDER);
  if (folder) {
    const ours = folder[1] === target.id && Number(folder[2]) === target.version;
    return ours ? [{ file, role: 'generated', patch, partial: false }] : [];
  }
  const kept = keepHunks(patch, hunk => letters(hunk).includes(target.name));
  return kept ? [{ file, role: 'generated', patch: kept, partial: kept !== patch }] : [];
}

/** The hunks of a source file or the API document that quote the operation's id. */
function quotedConnection(file: ReviewFile, patch: string, target: Target, role: ConnectionRole): Connection[] {
  const kept = keepHunks(patch, hunk => quotes(hunk, target));
  return kept ? [{ file, role, patch: kept, partial: true }] : [];
}

/**
 * What a contract change touches in this pull request: the route that declares the operation, the API document, and
 * what the generators wrote for it in the same app's SDK and CLI.
 */
export function connectionsOf(change: ContractChange, files: readonly ReviewFile[]): Connection[] {
  const [id, version] = operationParts(change.operation);
  const target = { id, version, document: change.document, name: letters(id) };
  const app = `${change.document.split('/').slice(0, 2).join('/')}/`;
  return files.flatMap((file): Connection[] => {
    // Only this app's files, with hunks to look in: its routes, its API document, then its SDK's and CLI's output.
    if (!file.path.startsWith(app) || file.patch === null) return [];
    if (file.category === 'source') return quotedConnection(file, file.patch, target, 'route');
    if (file.path === target.document) return quotedConnection(file, file.patch, target, 'contract');
    return file.category === 'generated' ? generatedConnection(file, file.patch, target) : [];
  });
}
