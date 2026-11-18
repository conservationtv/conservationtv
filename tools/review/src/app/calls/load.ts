import { parseDiffFromFile, type FileDiffMetadata } from '@pierre/diffs';
import type { Pull, ReviewFile } from '../../shared/review.ts';
import { rawFile } from '../api.ts';
import type { CallGraph, Located, Piece, Sides, Span } from './graph.ts';
import type { Call } from './units.ts';

// The source chapter's call graph, read in the browser from the files at the merge base and the head. The parser loads
// only when the graph is first shown.

/** TypeScript and JavaScript files, the only ones read for calls. */
function isScript(path: string): boolean {
  return /\.(?:[cm]?[jt]sx?)$/.test(path) && !path.endsWith('.d.ts');
}

/** A file as committed, or null where it is not. */
async function contents(sha: string, path: string): Promise<string | null> {
  try {
    return await rawFile(sha, path);
  } catch {
    return null;
  }
}

async function sidesOf(pull: Pull, file: ReviewFile): Promise<Sides> {
  const [before, after] = await Promise.all([
    file.status === 'added' ? null : contents(pull.mergeBaseSha, file.previousPath ?? file.path),
    file.status === 'removed' ? null : contents(pull.headSha, file.path)
  ]);
  return { path: file.path, before, after };
}

export async function loadCallGraph(pull: Pull, files: readonly ReviewFile[]): Promise<CallGraph> {
  const scripts = files.filter(file => isScript(file.path));
  const [{ callGraph }, sides] = await Promise.all([
    import('./graph.ts'),
    Promise.all(scripts.map(file => sidesOf(pull, file)))
  ]);
  const others = files.filter(file => !isScript(file.path)).map(file => file.path);
  return callGraph(sides, others);
}

/** Lines on both sides as a diff, numbered as they are in the file; `before` null where they are new. */
export function pieceDiff(path: string, { before, after }: Piece): FileDiffMetadata {
  const diff = parseDiffFromFile(before === null ? null : { name: path, contents: `${before.text}\n` }, {
    name: path,
    contents: `${after.text}\n`
  });
  for (const hunk of diff.hunks) {
    hunk.additionStart += after.start - 1;
    hunk.deletionStart += (before?.start ?? after.start) - 1;
  }
  diff.cacheKey = `${path}:${after.start}:${after.text.length}:${before?.start ?? 0}:${before?.text.length ?? 0}`;
  return diff;
}

/** A unit as it is now, as a span. */
function spanOf(unit: Located): Span {
  return { start: unit.start, end: unit.end, text: unit.text };
}

/**
 * A unit's pieces in file order: the changed declarations it is built from, and the whole of itself, its changes
 * marked against what its name was bound to. One that did not change is shown as it is.
 */
export function unitPieces(unit: Located): Piece[] {
  const own = { before: unit.status === 'same' ? spanOf(unit) : unit.previous, after: spanOf(unit) };
  return [...unit.context, own].toSorted((a, b) => a.after.start - b.after.start);
}

/** The lines of `text`, which starts at line `start`, from `from` to `to`. */
function linesOf(text: string, start: number, from: number, to: number): string {
  return text
    .split('\n')
    .slice(from - start, to - start + 1)
    .join('\n');
}

/**
 * A call where its caller makes it: its lines in the caller, marked as new unless the caller made the same call at the
 * merge base.
 */
export function callPiece(caller: Located, call: Call): Piece {
  const after = { start: call.line, end: call.end, text: linesOf(caller.text, caller.start, call.line, call.end) };
  const was = caller.status === 'same' ? spanOf(caller) : caller.previous;
  return { before: was ? sameLines(was, after) : null, after };
}

/** The same lines in what a caller was, if they are there: where the call was made before. */
function sameLines(was: Span, after: Span): Span | null {
  const wanted = after.text.split('\n').map(line => line.trim());
  const lines = was.text.split('\n').map(line => line.trim());
  for (let index = 0; index + wanted.length <= lines.length; index++) {
    if (wanted.every((line, offset) => lines[index + offset] === line)) {
      const start = was.start + index;
      return {
        start,
        end: start + wanted.length - 1,
        text: linesOf(was.text, was.start, start, start + wanted.length - 1)
      };
    }
  }
  return null;
}
