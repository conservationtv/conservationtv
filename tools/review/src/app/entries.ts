import type { FileDiffMetadata } from '@pierre/diffs';
import type { Category, FileStatus, ReviewFile } from '../shared/review.ts';
import { patchDiff } from './diffs.ts';

/** One diff in a topic or the list of files: a changed file, or the part of one a topic is about. */
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
  /** The changed file, when the entry shows it whole: it can be marked viewed and loaded in full. */
  file: ReviewFile | null;
  /** The changed file its lines are of, whole or in part: its threads show and it takes comments on those lines. */
  source: ReviewFile | null;
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
    source: file,
    diff: patchDiff(file)
  };
}

/** Some of a file's hunks, as one topic shows them: commented on like the whole file, but not marked viewed. */
export function partEntry(file: ReviewFile, patch: string, topic: string, folded: boolean): Entry {
  const diff = patchDiff({ ...file, patch });
  diff.cacheKey = `${diff.cacheKey}:${topic}`;
  return {
    id: file.path,
    title: file.path,
    previousTitle: file.previousPath,
    status: file.status,
    category: file.category,
    tag: file.generator,
    note: 'The part this topic is about; the rest of the file is in another',
    ...counts(diff),
    folded,
    file: null,
    source: file,
    diff
  };
}
