import type { CodeViewItem, DiffLineAnnotation, FileDiffMetadata, SelectedLineRange } from '@pierre/diffs';
import { CodeView, type CodeViewHandle, type CodeViewReactOptions } from '@pierre/diffs/react';
import { useMemo, useRef, useState, type FC, type ReactNode, type RefObject } from 'react';
import type { Review, ReviewFile } from '../../shared/review.ts';
import { fullDiff, isBinary, isMoved, loadSides } from '../diffs.ts';
import type { Drafts } from '../drafts.ts';
import type { Entry } from '../entries.ts';
import { formatCount } from '../format.ts';
import { lineTarget, type LineTarget, type Note } from '../notes.ts';
import { useSession } from '../session.ts';
import type { ViewedFiles } from '../viewed.ts';
import { theme } from '../highlighting.ts';
import { NoteView } from './LineNotes.tsx';

export type DiffStyle = 'split' | 'unified';

const statusLetters = {
  added: 'A',
  removed: 'D',
  modified: 'M',
  renamed: 'R',
  copied: 'C',
  changed: 'M',
  unchanged: '·'
} satisfies Record<ReviewFile['status'], string>;

/** FNV-1a: a cheap number that changes whenever what a diff item shows changes. */
function version(parts: readonly (string | number | boolean)[]): number {
  let hash = 0x811c9dc5;
  for (const char of parts.join('\u0000')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** What a note shows, for an item's version: a thread's comments, a draft, or where a comment is being written. */
function noteKey(note: Note): string {
  if (note.kind === 'thread') return `thread:${note.thread.comments.length}`;
  if (note.kind === 'draft') return `draft:${note.draft.id}`;
  return `composer:${note.target.side}:${note.target.line}`;
}

/** Which item a gutter click was in. */
interface GutterItem {
  id: string;
}

interface GutterContext {
  item: GutterItem;
}

/** What has happened to an entry since the chapter opened. */
interface EntryState {
  folded?: boolean;
  /** The whole diff, for a file GitHub did not inline. */
  full?: FileDiffMetadata;
  loading?: boolean;
  error?: string;
}

export type Viewer = RefObject<CodeViewHandle<Note, undefined> | null>;

interface DiffListProps {
  review: Review;
  entries: readonly Entry[];
  viewer: Viewer;
  viewed: ViewedFiles;
  drafts: Drafts;
  diffStyle: DiffStyle;
  header: ReactNode;
  footer: ReactNode;
}

/** A chapter's diffs in one scrolling list, with what to read open and the rest folded until asked for. */
export const DiffList: FC<DiffListProps> = props => {
  const { review, entries, viewer, viewed, drafts, diffStyle, header, footer } = props;
  const [states, setStates] = useState<Record<string, EntryState>>({});
  const threads = useMemo(() => Map.groupBy(review.threads, thread => thread.path), [review.threads]);
  const pending = useMemo(() => Map.groupBy(drafts.all, draft => draft.path), [drafts.all]);
  const signedIn = Boolean(useSession()?.viewer);
  // The comment being written, and what is written of it: kept here, as its line can scroll out of view and back.
  const [target, setTarget] = useState<LineTarget | null>(null);
  const written = useRef('');

  const update = (id: string, change: EntryState) =>
    setStates(current => ({ ...current, [id]: { ...current[id], ...change } }));
  // A whole file GitHub did not inline, and that has not been loaded yet.
  const needsLoading = (entry: Entry) =>
    entry.file !== null && entry.file.patch === null && !isBinary(entry.file) && !states[entry.id]?.full;
  // Folded as the reader left it, else folded when viewed, else as its chapter starts it.
  const isFolded = (entry: Entry) =>
    states[entry.id]?.folded ?? ((entry.file !== null && viewed.isViewed(entry.file)) || entry.folded);

  async function load(entry: Entry, file: ReviewFile) {
    update(entry.id, { loading: true, error: undefined });
    try {
      update(entry.id, { full: await fullDiff(review.pull, file), folded: false, loading: false });
    } catch (error) {
      update(entry.id, { loading: false, error: error instanceof Error ? error.message : 'Could not load the diff.' });
    }
  }

  function toggle(entry: Entry) {
    const folded = !isFolded(entry);
    if (!folded && entry.file && needsLoading(entry)) {
      void load(entry, entry.file);
      return;
    }
    update(entry.id, { folded });
  }

  function toggleViewed(entry: Entry, file: ReviewFile) {
    // Marking a file viewed folds it away; unmarking opens it again.
    update(entry.id, { folded: !viewed.isViewed(file) });
    viewed.toggle(file);
  }

  /**
   * Threads, pending comments and the comment being written: only on an entry showing a whole file, as GitHub's are.
   * Each kind is gathered from its own source and placed at its line.
   */
  function notesOf(entry: Entry): DiffLineAnnotation<Note>[] {
    if (!entry.file) return [];
    // A thread whose line has since changed is shown at the top of its file.
    const threadNotes = (threads.get(entry.file.path) ?? []).map(thread => ({
      side: thread.side,
      lineNumber: thread.line ?? 0,
      metadata: { kind: 'thread', thread } satisfies Note
    }));
    const draftNotes = (pending.get(entry.file.path) ?? []).map(draft => ({
      side: draft.side,
      lineNumber: draft.line,
      metadata: { kind: 'draft', draft } satisfies Note
    }));
    const composing = target?.entryId === entry.id ? [target] : [];
    const composerNotes = composing.map(line => ({
      side: line.side,
      lineNumber: line.line,
      metadata: { kind: 'composer', target: line } satisfies Note
    }));
    return [...threadNotes, ...draftNotes, ...composerNotes];
  }

  const items: CodeViewItem<Note>[] = entries.map(entry => {
    // Each entry as the viewer draws it: folded or not, its whole diff once loaded, and its notes; the version
    // changes whenever any of them does.
    const state = states[entry.id];
    const folded = isFolded(entry) || needsLoading(entry);
    const annotations = notesOf(entry);
    return {
      id: entry.id,
      type: 'diff',
      fileDiff: state?.full ?? entry.diff,
      collapsed: folded,
      annotations,
      version: version([
        entry.diff.cacheKey ?? entry.id,
        folded,
        Boolean(state?.full),
        ...annotations.map(({ metadata: note }) => noteKey(note))
      ])
    };
  });
  const byId = new Map(entries.map(entry => [entry.id, entry]));

  function compose(range: SelectedLineRange, context: GutterContext) {
    const entry = byId.get(context.item.id);
    const line = entry ? lineTarget(entry, range) : null;
    if (!line) return;
    written.current = '';
    setTarget(line);
  }

  const options: CodeViewReactOptions<Note, undefined> = {
    theme,
    diffStyle,
    stickyHeaders: true,
    loadDiffFiles: fileDiff => loadSides(review.pull, fileDiff.name, fileDiff.prevName),
    layout: { paddingTop: 0, paddingBottom: 96, gap: 12 },
    // The gutter's + comments on a line, or on the lines dragged over; signed in, as comments are the reviewer's own.
    enableGutterUtility: signedIn,
    onGutterUtilityClick: compose
  };

  return (
    <CodeView<Note, undefined>
      ref={viewer}
      className="code-view"
      items={items}
      options={options}
      renderCodeViewHeader={() => header}
      renderCodeViewFooter={() => footer}
      renderCustomHeader={item => {
        const entry = byId.get(item.id);
        if (!entry) return null;
        return (
          <EntryHeader
            entry={entry}
            folded={item.collapsed ?? false}
            state={states[entry.id]}
            viewed={entry.file ? viewed.isViewed(entry.file) : null}
            url={`${review.pull.url}/files`}
            onToggle={() => toggle(entry)}
            onViewed={() => entry.file && toggleViewed(entry, entry.file)}
          />
        );
      }}
      renderAnnotation={(...[annotation]) => (
        <NoteView
          pull={review.pull}
          note={annotation.metadata}
          drafts={drafts}
          written={written.current}
          onWrite={body => {
            written.current = body;
          }}
          onCloseComposer={() => setTarget(null)}
        />
      )}
    />
  );
};

interface EntryNoteProps {
  entry: Entry;
  folded: boolean;
  state: EntryState | undefined;
  url: string;
}

/** Why an entry shows no lines or what it leaves out; loading and failing say more than either. */
const EntryNote: FC<EntryNoteProps> = ({ entry, folded, state, url }) => {
  if (state?.error) return <span className="error-text">{state.error}</span>;
  if (state?.loading) return <span className="muted">Loading…</span>;
  return <AboutEntry entry={entry} folded={folded} loaded={Boolean(state?.full)} url={url} />;
};

interface AboutEntryProps {
  entry: Entry;
  folded: boolean;
  loaded: boolean;
  url: string;
}

/** A moved or binary file, one too large for GitHub to inline until it is opened, or what an entry leaves out. */
const AboutEntry: FC<AboutEntryProps> = ({ entry, folded, loaded, url }) => {
  // A move before a binary file: both have no lines to diff.
  if (entry.file && isMoved(entry.file)) return <span className="muted">Moved without changes</span>;
  if (entry.file && isBinary(entry.file)) return <a href={url}>Binary file: view on GitHub</a>;
  if (entry.file?.patch === null && !loaded && folded)
    return <span className="muted">Too large to inline: open to load</span>;
  return entry.note ? <span className="entry-note">{entry.note}</span> : null;
};

interface EntryHeaderProps {
  entry: Entry;
  folded: boolean;
  state: EntryState | undefined;
  /** Null when the entry is not a whole file, so there is nothing to mark viewed. */
  viewed: boolean | null;
  url: string;
  onToggle(): void;
  onViewed(): void;
}

interface EntryTitleProps {
  entry: Entry;
}

/** The file name whole, after as much of its directory as fits. */
const EntryTitle: FC<EntryTitleProps> = ({ entry }) => {
  const slash = entry.title.lastIndexOf('/') + 1;
  return (
    <span className="file-path" title={entry.title}>
      {entry.previousTitle ? <span className="file-dir">{entry.previousTitle} → </span> : null}
      <span className="file-dir">{entry.title.slice(0, slash)}</span>
      <span className="file-base">{entry.title.slice(slash)}</span>
    </span>
  );
};

/** An entry's header, drawn here so its line counts are GitHub's even when its diff has not been loaded. */
const EntryHeader: FC<EntryHeaderProps> = ({ entry, folded, state, viewed, url, onToggle, onViewed }) => (
  <div className={`file-header cat-${entry.category}${viewed ? ' viewed' : ''}`}>
    <button type="button" className="file-toggle" onClick={onToggle} aria-expanded={!folded}>
      <span className="chevron" aria-hidden>
        {folded ? '▸' : '▾'}
      </span>
      <span className={`status status-${entry.status}`} title={entry.status}>
        {statusLetters[entry.status]}
      </span>
      <span className="file-title">
        <EntryTitle entry={entry} />
        <EntryNote entry={entry} folded={folded} state={state} url={url} />
      </span>
    </button>
    {entry.tag ? <span className={`generator cat-${entry.category}`}>{entry.tag}</span> : null}
    <span className="file-stats">
      <span className="additions">+{formatCount(entry.additions)}</span>
      <span className="deletions">−{formatCount(entry.deletions)}</span>
    </span>
    {viewed === null ? null : <ViewedToggle viewed={viewed} onViewed={onViewed} />}
  </div>
);

interface ViewedToggleProps {
  viewed: boolean;
  onViewed(): void;
}

const ViewedToggle: FC<ViewedToggleProps> = ({ viewed, onViewed }) => (
  <label className="viewed-toggle">
    <input type="checkbox" checked={viewed} onChange={onViewed} />
    <span>Viewed</span>
  </label>
);
