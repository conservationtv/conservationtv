import { parseDiffFromFile, type FileDiffMetadata } from '@pierre/diffs';
import type { Category, ContractChange, FileStatus, ReviewFile } from '../shared/review.ts';
import { patchDiff } from './diffs.ts';
import type { Connection } from './story.ts';

/** One diff in a chapter: a changed file, the part of one that concerns an operation, or an operation's contract. */
export interface Entry {
  id: string;
  title: string;
  previousTitle: string | null;
  status: FileStatus;
  category: Category;
  /** What wrote it or what it is to the operation, shown beside its title. */
  tag: string | null;
  /** Why it shows less than the whole file, or what it is. */
  note: string | null;
  additions: number;
  deletions: number;
  folded: boolean;
  /** The changed file, when the entry shows it whole: it can be marked viewed, loaded in full and commented on. */
  file: ReviewFile | null;
  diff: FileDiffMetadata;
}

function counts(diff: FileDiffMetadata): Pick<Entry, 'additions' | 'deletions'> {
  return {
    additions: diff.hunks.reduce((sum, hunk) => sum + hunk.additionLines, 0),
    deletions: diff.hunks.reduce((sum, hunk) => sum + hunk.deletionLines, 0)
  };
}

export function fileEntry(file: ReviewFile, folded: boolean): Entry {
  return {
    id: file.path,
    title: file.path,
    previousTitle: file.previousPath,
    status: file.status,
    category: file.category,
    tag: file.generator,
    note: null,
    additions: file.additions,
    deletions: file.deletions,
    folded,
    file,
    diff: patchDiff(file)
  };
}

const roleTags = {
  route: 'route',
  contract: 'API document',
  generated: null
} satisfies Record<Connection['role'], string | null>;

/** A file as it concerns an operation: whole when it is the operation's alone, otherwise the hunks naming it. */
export function connectionEntry(connection: Connection, operation: string, folded: boolean): Entry {
  const { file } = connection;
  const diff = patchDiff({ ...file, patch: connection.patch });
  diff.cacheKey = `${diff.cacheKey}:${operation}`;
  return {
    id: `${operation}:${file.path}`,
    title: file.path,
    previousTitle: file.previousPath,
    status: file.status,
    category: file.category,
    tag: roleTags[connection.role] ?? file.generator,
    note: connection.partial ? `Only the hunks naming ${operation.slice(0, operation.lastIndexOf('@'))}` : null,
    ...(connection.partial ? counts(diff) : { additions: file.additions, deletions: file.deletions }),
    folded,
    file: connection.partial ? null : file,
    diff
  };
}

const contractStatuses = {
  added: 'added',
  changed: 'modified',
  removed: 'removed'
} satisfies Record<ContractChange['kind'], FileStatus>;

/** An operation's contract as the checks compare it, before and after, as a diff of its own. */
export function contractEntry(change: ContractChange): Entry {
  const name = `${change.operation}.contract.json`;
  const diff = parseDiffFromFile(
    change.before === null ? null : { name, contents: change.before },
    change.after === null ? null : { name, contents: change.after }
  );
  diff.cacheKey = `contract:${change.document}:${change.operation}:${change.before?.length}:${change.after?.length}`;
  return {
    id: `${change.operation}:contract`,
    title: name,
    previousTitle: null,
    status: contractStatuses[change.kind],
    category: 'contract',
    tag: 'contract',
    note: 'References resolved, descriptions left out: what the contracts check compares',
    ...counts(diff),
    folded: false,
    file: null,
    diff
  };
}
