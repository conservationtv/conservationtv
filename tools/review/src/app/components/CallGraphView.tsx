import type { FileDiffMetadata } from '@pierre/diffs';
import { FileDiff } from '@pierre/diffs/react';
import { useQuery } from '@tanstack/react-query';
import { useState, type FC } from 'react';
import type { Review, ReviewFile } from '../../shared/review.ts';
import type { CallGraph, CallNode, Located, Status } from '../calls/graph.ts';
import { callPiece, loadCallGraph, pieceDiff, unitPieces } from '../calls/load.ts';
import type { Call } from '../calls/units.ts';
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

/** A unit as it is declared: `ScheduleCheck.validate(condition)`, `PUT /`, `cn`. */
function declared(unit: Located): Display {
  if (unit.kind === 'route') return { qualifier: '', name: unit.name, args: '' };
  const dot = unit.name.lastIndexOf('.');
  const args = unit.kind === 'function' ? `(${unit.params})` : '';
  return { qualifier: unit.name.slice(0, dot + 1), name: unit.name.slice(dot + 1), args };
}

/** A call as it is written: `cn('flex gap-6', className)`. */
function written(call: Call): Display {
  const dot = call.text.lastIndexOf('.');
  return { qualifier: call.text.slice(0, dot + 1), name: call.text.slice(dot + 1), args: `(${call.args})` };
}

interface ShownProps {
  shown: Display;
}

const Shown: FC<ShownProps> = ({ shown }) => (
  <>
    <span className="muted">{shown.qualifier}</span>
    <strong>{shown.name}</strong>
    <span className="muted">{shown.args}</span>
  </>
);

interface DiffsProps {
  diffs: readonly FileDiffMetadata[];
  /** Split when the diff changes what was there; one wholly new or unchanged reads as a single column. */
  split: boolean;
  diffStyle: DiffStyle;
  wrap: boolean;
}

const Diffs: FC<DiffsProps> = ({ diffs, split, diffStyle, wrap }) => (
  <div className="call-diff">
    {diffs.map(diff => (
      <FileDiff
        key={diff.cacheKey}
        fileDiff={diff}
        options={{
          theme,
          diffStyle: split ? diffStyle : 'unified',
          overflow: wrap ? 'wrap' : 'scroll',
          expandUnchanged: true,
          disableFileHeader: true
        }}
      />
    ))}
  </div>
);

interface CallSiteProps {
  caller: Located;
  call: Call;
  diffStyle: DiffStyle;
  wrap: boolean;
}

/** A call as its caller makes it, opened to read its lines there. */
const CallSite: FC<CallSiteProps> = ({ caller, call, diffStyle, wrap }) => {
  const [open, setOpen] = useState(false);
  const diff = open ? pieceDiff(caller.path, callPiece(caller, call)) : null;
  return (
    <div className="call-site">
      <button
        type="button"
        className="call-row call-site-row"
        aria-expanded={open}
        title={`Called in ${caller.name} · ${caller.path}:${call.line}`}
        onClick={() => setOpen(current => !current)}
      >
        <span className="call-site-mark" aria-hidden>
          ↳
        </span>
        <span className="call-text">
          <Shown shown={written(call)} />
        </span>
        <span className="call-where">:{call.line}</span>
      </button>
      {diff ? <Diffs diffs={[diff]} split={false} diffStyle={diffStyle} wrap={wrap} /> : null}
    </div>
  );
};

interface CallRowProps {
  node: CallNode;
  /** The unit making `node.calls`; null at the top of a tree. */
  caller: Located | null;
  diffStyle: DiffStyle;
  wrap: boolean;
}

/**
 * A unit a call reaches, opened to read what it is bound to with what it is built from; under it, each call its caller
 * makes to it, opened to read that call where it is made, then the calls it makes into the change.
 */
const CallRow: FC<CallRowProps> = ({ node, caller, diffStyle, wrap }) => {
  const [open, setOpen] = useState(false);
  const { unit } = node;
  const diffs = open ? unitPieces(unit).map(piece => pieceDiff(unit.path, piece)) : [];
  const where = unit.path === caller?.path ? `:${unit.start}` : `${fileName(unit.path)}:${unit.start}`;
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
          <Shown shown={declared(unit)} />
          {node.recursive ? <span className="muted"> ↻</span> : null}
        </span>
        <span className="call-where">{where}</span>
      </button>
      {open ? <Diffs diffs={diffs} split={unit.status === 'changed'} diffStyle={diffStyle} wrap={wrap} /> : null}
      {caller && node.calls.length ? (
        <div className="call-sites">
          {node.calls.map(call => (
            <CallSite key={call.line} caller={caller} call={call} diffStyle={diffStyle} wrap={wrap} />
          ))}
        </div>
      ) : null}
      {node.children.length ? (
        <ul className="call-children">
          {node.children.map(child => (
            <CallRow key={child.unit.id} node={child} caller={unit} diffStyle={diffStyle} wrap={wrap} />
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
            <CallRow key={root.unit.id} node={root} caller={null} diffStyle={diffStyle} wrap={wrap} />
          ))}
        </ul>
      ) : (
        <p className="muted">No functions changed in TypeScript or JavaScript files.</p>
      )}
      <LeftOver graph={graph} onOpenFile={onOpenFile} />
    </div>
  );
};
