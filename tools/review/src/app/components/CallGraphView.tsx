import { FileDiff } from '@pierre/diffs/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type FC } from 'react';
import type { Review, ReviewFile } from '../../shared/review.ts';
import type { CallGraph, CallNode, Status } from '../calls/graph.ts';
import { loadCallGraph, unitDiff } from '../calls/load.ts';
import { theme } from '../highlighting.ts';
import type { DiffStyle } from './DiffList.tsx';

const statusLabels = {
  new: 'New',
  changed: 'Changed',
  same: 'Unchanged: calls into the change'
} satisfies Record<Status, string>;

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

interface Display {
  /** `ScheduleCheck.`, muted. */
  qualifier: string;
  /** `validate`, in bold. */
  name: string;
  /** `(condition)`, muted; empty for a value or a route. */
  args: string;
}

/** A node as its caller calls it, else as it is declared: `ScheduleCheck.validate(condition)`, `PUT /`. */
function display(node: CallNode): Display {
  const { unit, call } = node;
  if (unit.kind === 'route' && !call) return { qualifier: '', name: unit.name, args: '' };
  const text = call ? call.text : unit.name;
  const dot = text.lastIndexOf('.');
  const args = call ? `(${call.args})` : unit.kind === 'function' ? `(${unit.params})` : '';
  return { qualifier: text.slice(0, dot + 1), name: text.slice(dot + 1), args };
}

interface UnitDiffProps {
  node: CallNode;
  diffStyle: DiffStyle;
  wrap: boolean;
}

/** The whole unit, its changes marked; one that did not change is shown as it is. */
const UnitDiffView: FC<UnitDiffProps> = ({ node, diffStyle, wrap }) => {
  const diff = useMemo(() => unitDiff(node.unit), [node.unit]);
  return (
    <div className="call-diff">
      <FileDiff
        fileDiff={diff}
        options={{
          theme,
          diffStyle: node.unit.status === 'changed' ? diffStyle : 'unified',
          overflow: wrap ? 'wrap' : 'scroll',
          expandUnchanged: true,
          disableFileHeader: true
        }}
      />
    </div>
  );
};

interface CallRowProps {
  node: CallNode;
  /** The caller's file: a callee in it shows only its line. */
  parentPath: string | null;
  diffStyle: DiffStyle;
  wrap: boolean;
}

/** A call, opened to read the unit it reaches, and the calls that unit makes into the change. */
const CallRow: FC<CallRowProps> = ({ node, parentPath, diffStyle, wrap }) => {
  const [open, setOpen] = useState(false);
  const { unit } = node;
  const shown = display(node);
  const where = unit.path === parentPath ? `:${unit.start}` : `${fileName(unit.path)}:${unit.start}`;
  return (
    <li className="call">
      <button
        type="button"
        className="call-row"
        aria-expanded={open}
        title={`${statusLabels[unit.status]} · ${unit.path}:${unit.start}`}
        onClick={() => setOpen(current => !current)}
      >
        <span className={`call-status call-${unit.status}`} aria-label={statusLabels[unit.status]} />
        <span className="call-text">
          <span className="muted">{shown.qualifier}</span>
          <strong>{shown.name}</strong>
          <span className="muted">{shown.args}</span>
          {node.recursive ? <span className="muted"> ↻</span> : null}
        </span>
        <span className="call-where">{where}</span>
      </button>
      {open ? <UnitDiffView node={node} diffStyle={diffStyle} wrap={wrap} /> : null}
      {node.children.length ? (
        <ul className="call-children">
          {node.children.map(child => (
            <CallRow
              key={`${child.unit.id}:${child.call?.line ?? 0}`}
              node={child}
              parentPath={unit.path}
              diffStyle={diffStyle}
              wrap={wrap}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
};

interface LeftOverProps {
  graph: CallGraph;
  onOpenFile(path: string): void;
}

/** What the graph cannot show: removed units, and changes outside any unit or in files that are not scripts. */
const LeftOver: FC<LeftOverProps> = ({ graph, onOpenFile }) => (
  <>
    {graph.removed.length ? (
      <section className="call-extra">
        <h3>Removed</h3>
        <ul>
          {graph.removed.map(entry => (
            <li key={`${entry.path}#${entry.name}`}>
              <code>{entry.name}</code> <span className="muted">{fileName(entry.path)}</span>
            </li>
          ))}
        </ul>
      </section>
    ) : null}
    {graph.elsewhere.length ? (
      <section className="call-extra">
        <h3>Changed outside any function</h3>
        <ul>
          {graph.elsewhere.map(path => (
            <li key={path}>
              <button type="button" className="link-button" onClick={() => onOpenFile(path)}>
                {path}
              </button>
            </li>
          ))}
        </ul>
      </section>
    ) : null}
  </>
);

interface CallGraphViewProps {
  review: Review;
  files: readonly ReviewFile[];
  diffStyle: DiffStyle;
  wrap: boolean;
  onOpenFile(path: string): void;
}

/** The source chapter as the calls between what changed, each call opening onto its unit's diff. */
export const CallGraphView: FC<CallGraphViewProps> = ({ review, files, diffStyle, wrap, onOpenFile }) => {
  const { pull } = review;
  const {
    data: graph,
    error,
    isPending
  } = useQuery({
    queryKey: ['pulls', pull.number, 'calls', pull.headSha, pull.mergeBaseSha] as const,
    queryFn: () => loadCallGraph(pull, files),
    staleTime: Infinity
  });
  if (isPending) return <p className="muted">Reading the changed functions…</p>;
  if (error) return <p className="error-text">{error.message}</p>;
  return (
    <div className="call-graph">
      <p className="call-summary">
        <span className="call-status call-new" /> {graph.added} new
        <span className="call-status call-changed" /> {graph.changed} changed
        <span className="muted">
          {graph.files} file{graph.files === 1 ? '' : 's'}
        </span>
      </p>
      {graph.roots.length ? (
        <ul className="call-tree">
          {graph.roots.map(root => (
            <CallRow key={root.unit.id} node={root} parentPath={null} diffStyle={diffStyle} wrap={wrap} />
          ))}
        </ul>
      ) : (
        <p className="muted">No functions changed in TypeScript or JavaScript files.</p>
      )}
      <LeftOver graph={graph} onOpenFile={onOpenFile} />
    </div>
  );
};
