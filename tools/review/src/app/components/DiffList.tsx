import type { CodeViewItem, FileDiffMetadata } from '@pierre/diffs';
import { CodeView, type CodeViewHandle, type CodeViewReactOptions } from '@pierre/diffs/react';
import { useMemo, useState, type FC, type ReactNode, type RefObject } from 'react';
import type { Review, ReviewFile, Thread } from '../../shared/review.ts';
import { fullDiff, isBinary, loadSides } from '../diffs.ts';
import type { Entry } from '../entries.ts';
import { formatCount } from '../format.ts';
import type { ViewedFiles } from '../viewed.ts';
import { theme } from '../highlighting.ts';
import { ThreadView } from './ThreadView.tsx';

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

/** What has happened to an entry since the chapter opened. */
interface EntryState {
  folded?: boolean;
  /** The whole diff, for a file GitHub did not inline. */
  full?: FileDiffMetadata;
  loading?: boolean;
  error?: string;
}

export type Viewer = RefObject<CodeViewHandle<Thread, undefined> | null>;

interface DiffListProps {
  review: Review;
  entries: readonly Entry[];
  viewer: Viewer;
  viewed: ViewedFiles;
  diffStyle: DiffStyle;
  header: ReactNode;
  footer: ReactNode;
}

/** A chapter's diffs in one scrolling list, with what to read open and the rest folded until asked for. */
export const DiffList: FC<DiffListProps> = ({ review, entries, viewer, viewed, diffStyle, header, footer }) => {
  const [states, setStates] = useState<Record<string, EntryState>>({});
  const threads = useMemo(() => Map.groupBy(review.threads, thread => thread.path), [review.threads]);

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

  const items: CodeViewItem<Thread>[] = entries.map(entry => {
    const state = states[entry.id];
    // Threads are line comments on the whole file, so only an entry showing the whole file carries them.
    const entryThreads = entry.file ? (threads.get(entry.file.path) ?? []) : [];
    const folded = isFolded(entry) || needsLoading(entry);
    return {
      id: entry.id,
      type: 'diff',
      fileDiff: state?.full ?? entry.diff,
      collapsed: folded,
      // A thread whose line has since changed is shown at the top of its file.
      annotations: entryThreads.map(thread => ({ side: thread.side, lineNumber: thread.line ?? 0, metadata: thread })),
      version: version([
        entry.diff.cacheKey ?? entry.id,
        folded,
        Boolean(state?.full),
        entryThreads.reduce((count, thread) => count + thread.comments.length, 0)
      ])
    };
  });
  const byId = new Map(entries.map(entry => [entry.id, entry]));

  const options: CodeViewReactOptions<Thread, undefined> = {
    theme,
    diffStyle,
    stickyHeaders: true,
    loadDiffFiles: fileDiff => loadSides(review.pull, fileDiff.name, fileDiff.prevName),
    layout: { paddingTop: 0, paddingBottom: 96, gap: 12 }
  };

  return (
    <CodeView<Thread, undefined>
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
      renderAnnotation={(...[annotation]) => <ThreadView thread={annotation.metadata} />}
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

/** A binary file, one too large for GitHub to inline until it is opened, or what an entry leaves out. */
const AboutEntry: FC<AboutEntryProps> = ({ entry, folded, loaded, url }) => {
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
