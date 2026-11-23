import type { CallTreeNode, Lines } from '@conservationtv/runner/calls';
import { cn } from '@conservationtv/ui/lib/utils';
import { FileDiff } from '@pierre/diffs/react';
import { useState, type FC } from 'react';
import type { Review } from '../../shared/review.ts';
import { patchDiff } from '../diffs.ts';
import { theme } from '../highlighting.ts';
import { keepHunks } from '../story.ts';

// A topic's diffed call tree (tools/runner's calls report), drawn as calldiff draws one: each call its parent makes,
// in order, with rails between them, `+` for a call the head makes and the base didn't, `−` for one it no longer
// makes, `⇄` for one that moved. A function the pull request changed is in bold, and opens onto its own diff.

const marks = { same: '', added: '+', removed: '−', moved: '⇄' } satisfies Record<CallTreeNode['status'], string>;

const rowColours = {
  same: '',
  added: 'bg-(--success)/8 text-foreground',
  removed: 'bg-destructive/8 text-muted-foreground line-through decoration-destructive/40',
  moved: 'bg-(--warning)/8'
} satisfies Record<CallTreeNode['status'], string>;

const markColours = {
  same: '',
  added: 'text-(--success)',
  removed: 'text-destructive',
  moved: 'text-(--warning)'
} satisfies Record<CallTreeNode['status'], string>;

/** The hunks of a file's patch that touch a function's lines, on the side it was read from. */
function functionPatch(patch: string | null, lines: Lines, side: CallTreeNode['side']): string | null {
  if (!patch) return null;
  return keepHunks(patch, hunk => {
    // A hunk's lines on that side (`-a,b` at the base, `+c,d` at the head; a count left out is 1) overlap the function.
    const [, from = '1', fromCount = '1', to = '1', toCount = '1'] =
      hunk.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/) ?? [];
    const start = Number(side === 'head' ? to : from);
    const count = Number(side === 'head' ? toCount : fromCount);
    return start <= lines.end && start + Math.max(count, 1) - 1 >= lines.start;
  });
}

interface FunctionDiffProps {
  review: Review;
  node: CallTreeNode;
}

/** A changed function's own lines of the diff. */
const FunctionDiff: FC<FunctionDiffProps> = ({ review, node }) => {
  const file = review.files.find(each => each.path === node.path);
  const patch = file ? functionPatch(file.patch, node.lines, node.side) : null;
  if (!file || !patch) return <p className="px-3 py-2 text-xs text-muted-foreground">No diff of its own to show.</p>;
  const diff = patchDiff({ ...file, patch });
  diff.cacheKey = `${diff.cacheKey}:${node.key}`;
  return (
    <FileDiff fileDiff={diff} options={{ theme, diffStyle: 'unified', overflow: 'scroll', disableFileHeader: true }} />
  );
};

interface RowLabelProps {
  node: CallTreeNode;
  open: boolean;
  onOpen(): void;
}

/** A call's name: a changed function's opens its diff; a call back up says so. */
const RowLabel: FC<RowLabelProps> = ({ node, open, onOpen }) => (
  <>
    {node.changed && node.status !== 'removed' ? (
      <button
        type="button"
        className="cursor-pointer font-semibold text-foreground hover:underline"
        aria-expanded={open}
        title={`Show ${node.label}'s changes`}
        onClick={onOpen}
      >
        {node.label}
      </button>
    ) : (
      <span className={cn(node.changed && 'font-semibold')}>{node.label}</span>
    )}
    {node.recursive ? <span className="text-muted-foreground">⇄ calls back up</span> : null}
  </>
);

interface RowProps {
  review: Review;
  node: CallTreeNode;
  /** The rails drawn before it: `│  ` where an ancestor has calls after it, blank where not. */
  rails: string;
  last: boolean;
  root: boolean;
}

/** A call and, under it, the calls it makes; a changed one opens onto its diff. */
const Row: FC<RowProps> = ({ review, node, rails, last, root }) => {
  const [open, setOpen] = useState(false);
  const branch = root ? '' : last ? '└─ ' : '├─ ';
  const inner = root ? '' : `${rails}${last ? '   ' : '│  '}`;
  const file = node.path.split('/').at(-1);
  return (
    <>
      <li className={cn('flex items-baseline gap-2 px-2 leading-6 whitespace-pre', rowColours[node.status])}>
        <span className={cn('w-3 shrink-0 text-center font-semibold', markColours[node.status])}>
          {marks[node.status]}
        </span>
        <span className="text-muted-foreground/60">
          {rails}
          {branch}
        </span>
        <RowLabel node={node} open={open} onOpen={() => setOpen(current => !current)} />
        <span className="ml-auto truncate pl-4 text-[11px] text-muted-foreground">
          {node.site ? `${file} · called at ${node.site}` : `${node.path}:${node.lines.start}`}
        </span>
      </li>
      {open ? (
        <li className="my-1 ml-6 overflow-hidden rounded-md border border-border whitespace-normal">
          <FunctionDiff review={review} node={node} />
        </li>
      ) : null}
      {node.children.map((child, index) => (
        <Row
          key={`${child.key}:${index}`}
          review={review}
          node={child}
          rails={inner}
          last={index === node.children.length - 1}
          root={false}
        />
      ))}
    </>
  );
};

interface CallTreeViewProps {
  review: Review;
  tree: CallTreeNode;
}

export const CallTreeView: FC<CallTreeViewProps> = ({ review, tree }) => (
  <ol className="overflow-x-auto rounded-lg border border-border py-1 font-mono text-[12.5px]" aria-label="Calls">
    <Row review={review} node={tree} rails="" last root />
  </ol>
);
