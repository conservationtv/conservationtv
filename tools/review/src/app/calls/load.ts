import { parseDiffFromFile, type FileDiffMetadata } from '@pierre/diffs';
import type { Pull, ReviewFile } from '../../shared/review.ts';
import { rawFile } from '../api.ts';
import type { CallGraph, Located, Sides } from './graph.ts';

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

/** A unit's own diff, numbered as its lines are in the files: the whole of it, its changes marked. */
export function unitDiff(unit: Located): FileDiffMetadata {
  const before = unit.status === 'same' ? unit.text : (unit.previous?.text ?? null);
  const diff = parseDiffFromFile(before === null ? null : { name: unit.path, contents: `${before}\n` }, {
    name: unit.path,
    contents: `${unit.text}\n`
  });
  for (const hunk of diff.hunks) {
    hunk.additionStart += unit.start - 1;
    hunk.deletionStart += (unit.previous?.start ?? unit.start) - 1;
  }
  diff.cacheKey = `${unit.id}:${unit.start}:${unit.text.length}`;
  return diff;
}
