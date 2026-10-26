import type { SelectedLineRange } from '@pierre/diffs';
import type { LineComment, LineSide } from '../shared/actions.ts';
import type { Thread } from '../shared/review.ts';
import { commentable } from './diffs.ts';
import type { Draft } from './drafts.ts';
import type { Entry } from './entries.ts';

/** The lines a comment is being written on, in one entry of a diff list. */
export interface LineTarget {
  entryId: string;
  /** Null when GitHub would refuse a comment there: the reviewer is told why instead. */
  comment: Omit<LineComment, 'body'> | null;
  side: LineSide;
  line: number;
}

export interface ThreadNote {
  kind: 'thread';
  thread: Thread;
}

export interface DraftNote {
  kind: 'draft';
  draft: Draft;
}

export interface ComposerNote {
  kind: 'composer';
  target: LineTarget;
}

/** What sits under a line of a diff: a thread, a comment waiting for its review, or one being written. */
export type Note = ThreadNote | DraftNote | ComposerNote;

/**
 * The lines a gutter click or drag picked, as GitHub takes a comment on them: a range only on one side, so a drag
 * across sides comments on the line it ended on.
 */
export function lineTarget(entry: Entry, range: SelectedLineRange): LineTarget | null {
  if (!entry.file) return null;
  const side = range.endSide ?? range.side ?? 'additions';
  const sameSide = (range.side ?? side) === side;
  const from = sameSide ? Math.min(range.start, range.end) : range.end;
  const to = sameSide ? Math.max(range.start, range.end) : range.end;
  // A whole file GitHub did not inline has no lines GitHub would take a comment on.
  const allowed = entry.file.patch !== null && commentable(entry.diff, side, from, to);
  const start = from < to ? { side, line: from } : null;
  return {
    entryId: entry.id,
    side,
    line: to,
    comment: allowed ? { path: entry.file.path, side, line: to, start } : null
  };
}
