import { WorkerPoolContextProvider } from '@pierre/diffs/react';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState, type FC, type ReactNode } from 'react';
import type { OperationDocs } from '../../shared/operation.ts';
import type { ContractChange, Review, ReviewFile } from '../../shared/review.ts';
import { pullQueries } from '../api.ts';
import { GENERATED_SIGNOFF } from '../../shared/signoffs.ts';
import { connectionEntry, contractEntry, fileEntry, type Entry } from '../entries.ts';
import { formatCount } from '../format.ts';
import { highlighterOptions, poolOptions } from '../highlighting.ts';
import { chaptersOf, connectionsOf, operationParts, type Chapter, type ChapterId } from '../story.ts';
import { useViewed, type ViewedFiles } from '../viewed.ts';
import { useDrafts, type Drafts } from '../drafts.ts';
import { useSwitch } from '../preferences.ts';
import { ReviewSubmit } from './ReviewSubmit.tsx';
import { CallGraphView } from './CallGraphView.tsx';
import { ChangeTree } from './ChangeTree.tsx';
import { CheckMark, MarkdownBody } from './common.tsx';
import { DiffList, type DiffStyle, type Viewer } from './DiffList.tsx';
import { Link } from './Link.tsx';
import { OperationDocsView } from './OperationDocs.tsx';

interface ReviewViewProps {
  review: Review;
  chapter: string | undefined;
  operation: string | undefined;
}

export const ReviewView: FC<ReviewViewProps> = props => (
  <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
    <Story {...props} />
  </WorkerPoolContextProvider>
);

/** A phone has room for one side of a diff. */
function preferredStyle(): DiffStyle {
  return window.matchMedia('(max-width: 900px)').matches ? 'unified' : 'split';
}

/**
 * The chapter asked for, else the first, under the chapters and the reviewer's view switches: the file sidebar, wrapping
 * and the diff layout.
 */
const Story: FC<ReviewViewProps> = ({ review, chapter: chapterId, operation }) => {
  const viewer = useRef(null);
  const viewed = useViewed(review);
  const drafts = useDrafts(review);
  const [diffStyle, setDiffStyle] = useState(preferredStyle);
  const [sidebar, toggleSidebar] = useSwitch('sidebar', true);
  const [wrap, toggleWrap] = useSwitch('wrap', false);
  const chapters = chaptersOf(review);
  const index = Math.max(
    0,
    chapters.findIndex(chapter => chapter.id === chapterId)
  );
  const chapter = chapters[index];
  if (!chapter) return <main className="page narrow muted">This pull request changes no files.</main>;
  const next = chapters[index + 1];
  const context: ChapterContext = { review, chapter, next, viewer, viewed, drafts, diffStyle, wrap };
  return (
    <main className={sidebar ? 'review' : 'review sidebar-hidden'}>
      <StoryNav review={review} chapters={chapters} current={chapter.id} viewed={viewed}>
        <ReviewSubmit review={review} drafts={drafts} />
        <div className="segmented toggles" role="group" aria-label="View">
          <button type="button" className="sidebar-toggle" aria-pressed={sidebar} onClick={toggleSidebar}>
            Files
          </button>
          <button type="button" aria-pressed={wrap} onClick={toggleWrap}>
            Wrap
          </button>
        </div>
        <div className="segmented" role="group" aria-label="Diff layout">
          {(['split', 'unified'] as const).map(style => (
            <button key={style} type="button" aria-pressed={diffStyle === style} onClick={() => setDiffStyle(style)}>
              {style === 'split' ? 'Split' : 'Unified'}
            </button>
          ))}
        </div>
      </StoryNav>
      {chapter.id === 'api' ? (
        <ApiChapter key={operation ?? ''} context={context} operation={operation} />
      ) : (
        <FileChapter key={chapter.id} context={context} />
      )}
    </main>
  );
};

/** Everything a chapter is drawn with. */
interface ChapterContext {
  review: Review;
  chapter: Chapter;
  next: Chapter | undefined;
  viewer: Viewer;
  viewed: ViewedFiles;
  /** Line comments waiting for the review they belong to. */
  drafts: Drafts;
  diffStyle: DiffStyle;
  /** Long lines wrapped rather than scrolled sideways. */
  wrap: boolean;
}

function chapterUrl(review: Review, id: ChapterId): string {
  return `/pr/${review.pull.number}/files/${id}`;
}

interface StoryNavProps {
  review: Review;
  chapters: readonly Chapter[];
  current: ChapterId;
  viewed: ViewedFiles;
  children: ReactNode;
}

/** The chapters in reading order, each with how much of it is viewed. */
const StoryNav: FC<StoryNavProps> = ({ review, chapters, current, viewed, children }) => (
  <nav className="story-nav" aria-label="Review">
    <ol>
      {chapters.map((chapter, index) => {
        // The API chapter counts operations; the others count their files and how many are viewed.
        const count =
          chapter.id === 'api'
            ? `${review.contracts.length} op${review.contracts.length === 1 ? '' : 's'}`
            : `${chapter.files.filter(file => viewed.isViewed(file)).length}/${chapter.files.length}`;
        return (
          <li key={chapter.id} className={chapter.id === current ? 'current' : undefined}>
            <Link to={chapterUrl(review, chapter.id)}>
              <span className="step">{index + 1}</span>
              <span className="step-title">{chapter.title}</span>
              <span className="step-count">{count}</span>
            </Link>
          </li>
        );
      })}
    </ol>
    {children}
  </nav>
);

interface NextChapterProps {
  context: ChapterContext;
}

const NextChapter: FC<NextChapterProps> = ({ context }) =>
  context.next ? (
    <div className="next-chapter">
      <Link to={chapterUrl(context.review, context.next.id)}>Next: {context.next.title} →</Link>
    </div>
  ) : (
    <div className="next-chapter muted">That is the whole pull request.</div>
  );

function lines(files: readonly ReviewFile[]): string {
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return `+${formatCount(additions)} −${formatCount(deletions)}`;
}

function plural(count: number, noun: string): string {
  return `${formatCount(count)} ${noun}${count === 1 ? '' : 's'}`;
}

interface IntroProps {
  context: ChapterContext;
  children?: ReactNode;
}

/** What a chapter holds, and what to look for in it. */
const Intro: FC<IntroProps> = ({ context, children }) => {
  const { review, chapter } = context;
  const files = chapter.files;
  const leads = {
    code: `${plural(files.length, 'source file')}. This is the change itself: everything in the chapters after it follows from it, so start here.`,
    schema: `${plural(files.length, 'migration')} drizzle-kit wrote from the schema changes. They run against every database exactly as written, so read them as SQL: locks, defaults on existing rows, and data that has to move.`,
    api: '',
    generated: `${plural(files.length, 'file')} written by generators from the source code, the migrations and the API contract. Read those instead; these are folded away.`,
    dependencies: 'The lockfile, as pnpm resolved the package.json changes in the source code.'
  } satisfies Record<ChapterId, string>;
  const threads = review.threads.filter(thread => files.some(file => file.path === thread.path)).length;
  return (
    <header className="intro">
      <h2>
        {chapter.title} <span className="muted">{lines(files)}</span>
      </h2>
      <p>{leads[chapter.id]}</p>
      {threads ? (
        <p className="muted">{plural(threads, 'comment thread')} on these files, shown on their lines.</p>
      ) : null}
      {children}
    </header>
  );
};

/** The generators behind a chapter of generated files, how much each wrote, and whether it was signed off. */
const GeneratedSummary: FC<IntroProps> = ({ context }) => {
  const signoff = context.review.checks.find(check => check.name === GENERATED_SIGNOFF);
  const groups = Map.groupBy(context.chapter.files, file => file.generator ?? 'generator');
  return (
    <>
      <p className={signoff?.state === 'success' ? 'signoff signed' : 'signoff'}>
        <CheckMark state={signoff?.state ?? 'pending'} />
        {signoff?.state === 'success'
          ? ' signoff/generated: every API document, SDK and CLI was regenerated at this commit and nothing changed. These files are what their generators write.'
          : ' Not signed off as current at this commit: run pnpm signoff:generated. Until then these may not be what their generators write.'}
      </p>
      <ul className="generators">
        {[...groups].map(([generator, files]) => (
          <li key={generator}>
            <button
              type="button"
              className="link-button"
              onClick={() =>
                context.viewer.current?.scrollTo({ type: 'item', id: files[0]?.path ?? '', align: 'start' })
              }
            >
              {generator}
            </button>
            <span className="muted">{plural(files.length, 'file')}</span>
            <span className="muted">{lines(files)}</span>
          </li>
        ))}
      </ul>
    </>
  );
};

/** Source chapters open; generated and dependency chapters are there to be checked, so they start folded. */
const foldedChapters: ReadonlySet<ChapterId> = new Set(['generated', 'dependencies']);

interface FileChapterProps {
  context: ChapterContext;
}

interface ViewSwitchProps {
  calls: boolean;
  onToggle(): void;
}

/** The source chapter as calls between what changed, or as its files. */
const ViewSwitch: FC<ViewSwitchProps> = ({ calls, onToggle }) => (
  <div className="segmented view-switch" role="group" aria-label="Read the source code as">
    <button type="button" aria-pressed={calls} onClick={calls ? undefined : onToggle}>
      Calls
    </button>
    <button type="button" aria-pressed={!calls} onClick={calls ? onToggle : undefined}>
      Files
    </button>
  </div>
);

interface CallChapterProps {
  context: ChapterContext;
  onOpenFile(path: string): void;
  onToggle(): void;
}

/** The source code as the calls between the functions that changed. */
const CallChapter: FC<CallChapterProps> = ({ context, onOpenFile, onToggle }) => (
  <div className="review-body calls-body">
    <section className="review-main call-scroll">
      <Intro context={context}>
        <ViewSwitch calls onToggle={onToggle} />
      </Intro>
      <CallGraphView
        review={context.review}
        files={context.chapter.files}
        diffStyle={context.diffStyle}
        wrap={context.wrap}
        onOpenFile={onOpenFile}
      />
      <NextChapter context={context} />
    </section>
  </div>
);

/** The source chapter opens on its calls; every chapter can be read file by file. */
const FileChapter: FC<FileChapterProps> = ({ context }) => {
  const [calls, toggleCalls] = useSwitch('calls', true);
  const { chapter, viewer } = context;
  if (chapter.id === 'code' && calls) {
    const openFile = (path: string) => {
      toggleCalls();
      // The files' list mounts first; then it can scroll.
      setTimeout(() => viewer.current?.scrollTo({ type: 'item', id: path, align: 'start' }), 100);
    };
    return <CallChapter context={context} onOpenFile={openFile} onToggle={toggleCalls} />;
  }
  return <FilesChapter context={context} onToggle={chapter.id === 'code' ? toggleCalls : null} />;
};

interface FilesChapterProps {
  context: ChapterContext;
  /** Switches the source chapter back to its calls; null for the other chapters. */
  onToggle: (() => void) | null;
}

const FilesChapter: FC<FilesChapterProps> = ({ context, onToggle }) => {
  const { review, chapter, viewer, viewed, diffStyle } = context;
  const folded = foldedChapters.has(chapter.id);
  // Generated files read best by what wrote them.
  const files =
    chapter.id === 'generated'
      ? chapter.files.toSorted(
          (a, b) => (a.generator ?? '').localeCompare(b.generator ?? '') || a.path.localeCompare(b.path)
        )
      : chapter.files;
  const entries = files.map(file => fileEntry(file, folded));
  return (
    <div className="review-body">
      <aside className="review-sidebar">
        <ChangeTree
          files={files}
          onOpen={path => viewer.current?.scrollTo({ type: 'item', id: path, align: 'start' })}
        />
      </aside>
      <section className="review-main">
        <DiffList
          review={review}
          entries={entries}
          viewer={viewer}
          viewed={viewed}
          drafts={context.drafts}
          diffStyle={diffStyle}
          wrap={context.wrap}
          header={
            <Intro context={context}>
              {onToggle ? <ViewSwitch calls={false} onToggle={onToggle} /> : null}
              {chapter.id === 'generated' ? <GeneratedSummary context={context} /> : null}
            </Intro>
          }
          footer={<NextChapter context={context} />}
        />
      </section>
    </div>
  );
};

const kindOrder = { added: 0, changed: 1, removed: 2 } satisfies Record<ContractChange['kind'], number>;
const kindLabels = {
  added: 'New operation',
  changed: 'Changed contract',
  removed: 'Removed'
} satisfies Record<ContractChange['kind'], string>;

/** `apps/studio/api/contracts/openapi.json` names the studio API. */
function apiName(document: string): string {
  const [, app, api] = document.match(/^apps\/([^/]+)\/([^/]+)\//) ?? [];
  return app ? `${app} ${api}` : document;
}

interface OperationListProps {
  review: Review;
  changes: readonly ContractChange[];
  selected: ContractChange | undefined;
}

const OperationList: FC<OperationListProps> = ({ review, changes, selected }) => (
  <ul className="operations">
    {changes.map(change => (
      <li key={`${change.document}:${change.operation}`} className={change === selected ? 'current' : undefined}>
        <Link to={`${chapterUrl(review, 'api')}/${encodeURIComponent(change.operation)}`}>
          <span className={`contract-dot contract-${change.kind}`} title={kindLabels[change.kind]} />
          <span className="operation-id">
            {/* Long ids wrap after a dot, never inside a name. */}
            {change.operation.split('.').map((part, index) => (
              <span key={index}>
                {index ? <wbr /> : null}
                {index ? `.${part}` : part}
              </span>
            ))}
          </span>
          <span className="method">{change.method}</span>
        </Link>
      </li>
    ))}
  </ul>
);

interface OperationHeaderProps {
  context: ChapterContext;
  change: ContractChange;
  docs: OperationDocsState;
  entries: readonly Entry[];
  showGenerated: boolean;
  onShowGenerated(): void;
  operations: ReactNode;
}

/** Explains what a kind of contract change means to the clients that use it. */
function consequence(change: ContractChange): string {
  const [id, version] = operationParts(change.operation);
  if (change.kind === 'added') {
    return `A new operation version: clients that ask for ${id} v${version} get this contract. It is frozen once released, so later changes need v${version + 1}.`;
  }
  if (change.kind === 'removed') {
    return `Clients that require ${id} v${version} will no longer be served. Check nothing released still asks for it.`;
  }
  return `${id} v${version} existed before this pull request, and its contract differs. Fine before it is released; after that, keep v${version} as it was and declare v${version + 1}.`;
}

/** What the operation is, what its change means to clients, and where in the pull request each part of it is. */
const OperationHeader: FC<OperationHeaderProps> = ({
  context,
  change,
  docs,
  entries,
  showGenerated,
  onShowGenerated,
  operations
}) => {
  const trace = [
    { label: 'Contract', ids: entries.filter(entry => entry.tag === 'contract') },
    { label: 'Route', ids: entries.filter(entry => entry.tag === 'route') },
    { label: 'API document', ids: entries.filter(entry => entry.tag === 'API document') },
    { label: 'Generated', ids: entries.filter(entry => entry.category === 'generated') }
  ].filter(step => step.ids.length > 0);
  const generated = entries.filter(entry => entry.category === 'generated').length;
  return (
    <header className="intro operation">
      <div className="narrow-only">{operations}</div>
      <p className="eyebrow">
        <span className={`contract-kind contract-${change.kind}`}>{kindLabels[change.kind]}</span>
        <span className="muted">{apiName(change.document)}</span>
      </p>
      <h2 className="endpoint">
        <span className="method">{change.method}</span> <code>{change.path}</code>
      </h2>
      <p className="operation-name">
        <code>{change.operation}</code>
        {change.summary ? <span> · {change.summary}</span> : null}
      </p>
      <p className={change.kind === 'added' ? 'consequence' : 'consequence warning'}>{consequence(change)}</p>
      {change.description ? <MarkdownBody text={change.description} /> : null}
      <DocsState docs={docs} kind={change.kind} />
      <h3 className="docs-heading">In this pull request</h3>
      <ol className="trace" aria-label="Where this operation is in the pull request">
        {trace.map(step => (
          <li key={step.label}>
            <button
              type="button"
              className="link-button"
              onClick={() =>
                context.viewer.current?.scrollTo({ type: 'item', id: step.ids[0]?.id ?? '', align: 'start' })
              }
            >
              {step.label}
            </button>
            <span className="muted">{step.ids.length > 1 ? plural(step.ids.length, 'file') : null}</span>
          </li>
        ))}
      </ol>
      {generated ? (
        <button type="button" className="button" onClick={onShowGenerated}>
          {showGenerated ? 'Fold' : 'Open'} the {plural(generated, 'generated file')}
        </button>
      ) : null}
    </header>
  );
};

/** The documentation as it loads: it is fetched when an operation's page opens. */
interface OperationDocsState {
  data: OperationDocs | undefined;
  error: Error | null;
}

interface DocsStateProps {
  docs: OperationDocsState;
  kind: ContractChange['kind'];
}

const DocsState: FC<DocsStateProps> = ({ docs, kind }) => {
  if (docs.error) return <p className="error-text">{docs.error.message}</p>;
  if (!docs.data) return <p className="muted">Loading the documentation…</p>;
  return <OperationDocsView docs={docs.data} kind={kind} />;
};

interface ApiChapterProps {
  context: ChapterContext;
  operation: string | undefined;
}

const ApiChapter: FC<ApiChapterProps> = ({ context, operation }) => {
  const { review, viewer, viewed, diffStyle } = context;
  const [showGenerated, setShowGenerated] = useState(false);
  const changes = review.contracts.toSorted(
    (a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.operation.localeCompare(b.operation)
  );
  const change = changes.find(candidate => candidate.operation === operation) ?? changes[0];
  const docs = useQuery({
    ...pullQueries.operation(review.pull.number, change?.document ?? '', change?.operation ?? ''),
    enabled: change !== undefined
  });
  const roleOrder = { route: 0, contract: 1, generated: 2 };
  const entries = change
    ? [
        ...(docs.data ? [contractEntry(change, docs.data)] : []),
        ...connectionsOf(change, review.files)
          .toSorted((a, b) => roleOrder[a.role] - roleOrder[b.role])
          .map(connection =>
            connectionEntry(connection, change.operation, connection.role === 'generated' && !showGenerated)
          )
      ]
    : context.chapter.files.map(file => fileEntry(file, true));
  const operations = <OperationList review={review} changes={changes} selected={change} />;
  return (
    <div className="review-body">
      <aside className="review-sidebar">
        <p className="sidebar-heading">{plural(changes.length, 'operation')}</p>
        {operations}
        <p className="sidebar-heading">API documents</p>
        <ul className="operations">
          {context.chapter.files.map(file => (
            <li key={file.path}>
              <a href={`${review.pull.url}/files`} title={file.path}>
                <span className="operation-id">{file.path}</span>
              </a>
            </li>
          ))}
        </ul>
      </aside>
      <section className="review-main">
        <DiffList
          // Opening or folding every generated file starts the list afresh.
          key={String(showGenerated)}
          review={review}
          entries={entries}
          viewer={viewer}
          viewed={viewed}
          drafts={context.drafts}
          diffStyle={diffStyle}
          wrap={context.wrap}
          header={
            change ? (
              <OperationHeader
                context={context}
                change={change}
                docs={docs}
                entries={entries}
                showGenerated={showGenerated}
                onShowGenerated={() => setShowGenerated(current => !current)}
                operations={operations}
              />
            ) : (
              <Intro context={context} />
            )
          }
          footer={<NextChapter context={context} />}
        />
      </section>
    </div>
  );
};
