import { getSingularPatch, parseDiffFromFile, type FileDiffLoadedFiles, type FileDiffMetadata } from '@pierre/diffs';
import type { LineSide } from '../shared/actions.ts';
import type { Pull, ReviewFile } from '../shared/review.ts';
import { rawFile } from './api.ts';

/**
 * A file's diff from GitHub's hunks. GitHub leaves out the file header, so it is written here from what the file
 * listing says; a file GitHub did not inline gets the header alone, with no hunks, until its contents are loaded.
 */
export function patchDiff(file: ReviewFile): FileDiffMetadata {
  const previous = file.previousPath ?? file.path;
  const from = file.status === 'added' ? '/dev/null' : `a/${previous}`;
  const to = file.status === 'removed' ? '/dev/null' : `b/${file.path}`;
  const rename = file.previousPath ? `rename from ${previous}\nrename to ${file.path}\n` : '';
  const header = `diff --git a/${previous} b/${file.path}\n${rename}--- ${from}\n+++ ${to}\n`;
  const diff = getSingularPatch(file.patch ? `${header}${file.patch}\n` : header);
  diff.cacheKey = `${file.path}@${file.blob}`;
  return diff;
}

/** Both sides of a file: the old one where the head branch left its base, the new one at the head commit. */
export async function loadSides(
  pull: Pull,
  path: string,
  previousPath: string | undefined
): Promise<FileDiffLoadedFiles> {
  const [before, after] = await Promise.all([
    rawFile(pull.mergeBaseSha, previousPath ?? path),
    rawFile(pull.headSha, path)
  ]);
  return {
    oldFile: { name: previousPath ?? path, contents: before, cacheKey: `${pull.mergeBaseSha}:${previousPath ?? path}` },
    newFile: { name: path, contents: after, cacheKey: `${pull.headSha}:${path}` }
  };
}

/** The whole diff of a file GitHub would not inline, worked out from both sides. */
export async function fullDiff(pull: Pull, file: ReviewFile): Promise<FileDiffMetadata> {
  const before = file.status === 'added' ? null : await rawFile(pull.mergeBaseSha, file.previousPath ?? file.path);
  const after = file.status === 'removed' ? null : await rawFile(pull.headSha, file.path);
  const diff = parseDiffFromFile(
    before === null ? null : { name: file.previousPath ?? file.path, contents: before },
    after === null ? null : { name: file.path, contents: after }
  );
  diff.cacheKey = `${file.path}@${file.blob}:full`;
  return diff;
}

/** A file moved without a line changed: GitHub sends no patch for it, as for a binary file. */
export function isMoved(file: ReviewFile): boolean {
  return file.status === 'renamed' && file.additions === 0 && file.deletions === 0;
}

/** Binary files have no lines to diff. */
export function isBinary(file: ReviewFile): boolean {
  return file.patch === null && file.additions === 0 && file.deletions === 0;
}

/**
 * Whether GitHub takes a comment on these lines: only lines its own diff shows, so not context expanded beyond a hunk,
 * and a range only within one hunk.
 */
export function commentable(diff: FileDiffMetadata, side: LineSide, from: number, to: number): boolean {
  return diff.hunks.some(hunk => {
    const start = side === 'additions' ? hunk.additionStart : hunk.deletionStart;
    const count = side === 'additions' ? hunk.additionCount : hunk.deletionCount;
    return from >= start && to < start + count;
  });
}
