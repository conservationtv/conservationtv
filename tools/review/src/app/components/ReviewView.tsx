import { Badge } from '@conservationtv/ui/components/badge';
import { Spinner } from '@conservationtv/ui/components/spinner';
import { Toggle } from '@conservationtv/ui/components/toggle';
import { ToggleGroup, ToggleGroupItem } from '@conservationtv/ui/components/toggle-group';
import { cn } from '@conservationtv/ui/lib/utils';
import {
  DatabaseIcon,
  DotsThreeIcon,
  FileIcon,
  FunctionIcon,
  PlugsConnectedIcon,
  type Icon
} from '@phosphor-icons/react';
import { WorkerPoolContextProvider } from '@pierre/diffs/react';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState, type FC, type ReactNode } from 'react';
import { isReviewBot } from '../../shared/bots.ts';
import type { Review } from '../../shared/review.ts';
import { callsQuery } from '../api.ts';
import { useDrafts, type Drafts } from '../drafts.ts';
import { fileEntry, partEntry, type Entry } from '../entries.ts';
import { formatCount } from '../format.ts';
import { highlighterOptions, poolOptions } from '../highlighting.ts';
import { useSwitch } from '../preferences.ts';
import { topicsOf, type Topic, type TopicKind } from '../topics.ts';
import { useViewed, type ViewedFiles } from '../viewed.ts';
import { ChangeTree } from './ChangeTree.tsx';
import { DiffList, type DiffStyle, type Viewer } from './DiffList.tsx';
import { Link } from './Link.tsx';
import { ReviewSubmit } from './ReviewSubmit.tsx';
import { TopicIntro } from './TopicIntro.tsx';

// The files tab: the pull request as topics (src/app/topics.ts), each one thing that changed with everything that
// follows from it, read one at a time from the rail; or every file at once, as a tree, for reading file by file.

interface ReviewViewProps {
  review: Review;
  /** A topic's id, `all` for every file, or none for the first topic. */
  chapter: string | undefined;
}

export const ReviewView: FC<ReviewViewProps> = props => (
  <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
    <Topics {...props} />
  </WorkerPoolContextProvider>
);

/** A phone has room for one side of a diff. */
function preferredStyle(): DiffStyle {
  return window.matchMedia('(max-width: 900px)').matches ? 'unified' : 'split';
}

const ALL_FILES = 'all';

/** Everything a topic or the file list is drawn with. */
interface ReadingContext {
  review: Review;
  viewer: Viewer;
  viewed: ViewedFiles;
  /** Line comments waiting for the review they belong to. */
  drafts: Drafts;
  diffStyle: DiffStyle;
  /** Long lines wrapped rather than scrolled sideways. */
  wrap: boolean;
}

/** The topic asked for, else the first; none for the list of every file. */
function chosenTopic(topics: readonly Topic[], chapter: string | undefined): Topic | null {
  if (chapter === ALL_FILES) return null;
  return topics.find(topic => topic.id === chapter) ?? topics[0] ?? null;
}

/** How the topics were found: from the calls report, or file by file without one. */
function summaryOf(topics: readonly Topic[], fromCalls: boolean): string {
  if (fromCalls) return `${topics.length} topics, from the calls into what changed`;
  return 'Topics by file: run pnpm signoff calls for topics by the calls between them';
}

/** The topics, from the calls report once it has loaded; the one asked for, or the whole list of files. */
const Topics: FC<ReviewViewProps> = ({ review, chapter }) => {
  const viewer = useRef(null);
  const viewed = useViewed(review);
  const drafts = useDrafts(review);
  const [diffStyle, setDiffStyle] = useState(preferredStyle);
  const [sidebar, toggleSidebar] = useSwitch('sidebar', true);
  const [wrap, toggleWrap] = useSwitch('wrap', false);
  const calls = useQuery(callsQuery(review.pull.headSha));
  if (!review.files.length) return <main className="page narrow muted">This pull request changes no files.</main>;
  if (calls.isPending) {
    return (
      <main className="page narrow flex items-center gap-2 text-muted-foreground">
        <Spinner /> Reading the calls report…
      </main>
    );
  }
  const topics = topicsOf(review, calls.data ?? null);
  const context: ReadingContext = { review, viewer, viewed, drafts, diffStyle, wrap };
  const topic = chosenTopic(topics, chapter);
  return (
    <main className={sidebar ? 'review' : 'review sidebar-hidden'}>
      <ReviewBar
        review={review}
        drafts={drafts}
        summary={summaryOf(topics, calls.data !== null)}
        sidebar={sidebar}
        onSidebar={toggleSidebar}
        wrap={wrap}
        onWrap={toggleWrap}
        diffStyle={diffStyle}
        onDiffStyle={setDiffStyle}
      />
      <div className="review-body">
        <aside className="review-sidebar">
          <TopicRail review={review} topics={topics} current={topic?.id ?? ALL_FILES} />
        </aside>
        <section className="review-main">
          {topic ? (
            <TopicReading key={topic.id} context={context} topic={topic} next={topics[topics.indexOf(topic) + 1]} />
          ) : (
            <AllFiles context={context} />
          )}
        </section>
      </div>
    </main>
  );
};

interface ReviewBarProps {
  review: Review;
  drafts: Drafts;
  summary: string;
  sidebar: boolean;
  onSidebar(): void;
  wrap: boolean;
  onWrap(): void;
  diffStyle: DiffStyle;
  onDiffStyle(style: DiffStyle): void;
}

/** Above the topics: how they were found, finishing the review, and the reviewer's view switches. */
const ReviewBar: FC<ReviewBarProps> = props => (
  <nav className="story-nav" aria-label="Review">
    <p className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">{props.summary}</p>
    <ReviewSubmit review={props.review} drafts={props.drafts} />
    <div className="flex shrink-0 gap-0.5" role="group" aria-label="View">
      {/* A phone shows one side and no sidebar, so only wrapping is left to choose. */}
      <Toggle
        variant="outline"
        size="sm"
        pressed={props.sidebar}
        onPressedChange={props.onSidebar}
        className="max-[900px]:hidden"
      >
        Topics
      </Toggle>
      <Toggle variant="outline" size="sm" pressed={props.wrap} onPressedChange={props.onWrap}>
        Wrap
      </Toggle>
    </div>
    <ToggleGroup
      variant="outline"
      size="sm"
      spacing={0}
      aria-label="Diff layout"
      className="shrink-0 max-[900px]:hidden"
      value={[props.diffStyle]}
      onValueChange={([style]) => {
        if (style === 'split' || style === 'unified') props.onDiffStyle(style);
      }}
    >
      <ToggleGroupItem value="split">Split</ToggleGroupItem>
      <ToggleGroupItem value="unified">Unified</ToggleGroupItem>
    </ToggleGroup>
  </nav>
);

const kindIcons = {
  operation: PlugsConnectedIcon,
  change: FunctionIcon,
  file: FileIcon,
  database: DatabaseIcon,
  rest: DotsThreeIcon
} satisfies Record<TopicKind, Icon>;

interface TopicRailProps {
  review: Review;
  topics: readonly Topic[];
  current: string;
}

/** The topics in reading order, each with how much it changes and the threads still open on it; then every file. */
const TopicRail: FC<TopicRailProps> = ({ review, topics, current }) => (
  <nav aria-label="Topics" className="flex flex-col gap-0.5 p-2">
    {topics.map(topic => (
      <RailItem key={topic.id} review={review} topic={topic} current={topic.id === current} />
    ))}
    <Link
      to={`/pr/${review.pull.number}/files/${ALL_FILES}`}
      className={cn(
        'mt-2 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-muted hover:no-underline',
        current === ALL_FILES && 'bg-muted text-foreground'
      )}
    >
      All {review.files.length} files, as a tree
    </Link>
  </nav>
);

interface RailItemProps {
  review: Review;
  topic: Topic;
  current: boolean;
}

/** A topic in the rail: what kind, its name, how much it changes, and its open threads (a bot's marked). */
const RailItem: FC<RailItemProps> = ({ review, topic, current }) => {
  const KindIcon = kindIcons[topic.kind];
  const open = topic.threads.filter(thread => thread.resolved !== true);
  const fromBots = open.some(thread => isReviewBot(thread.comments[0]?.author.login ?? ''));
  return (
    <Link
      to={`/pr/${review.pull.number}/files/${topic.id}`}
      className={cn(
        'flex items-start gap-2 rounded-md px-2 py-1.5 text-foreground hover:bg-muted hover:no-underline',
        current && 'bg-muted'
      )}
    >
      <KindIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn('truncate text-[13px]', current && 'font-semibold')}>{topic.title}</span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          +{formatCount(topic.additions)} −{formatCount(topic.deletions)}
          {topic.subtitle ? ` · ${topic.subtitle.split('/').at(-1)}` : ''}
        </span>
      </span>
      {open.length ? (
        <Badge
          variant={fromBots ? 'outline' : 'secondary'}
          className={cn(fromBots && 'border-(--warning) text-(--warning)')}
        >
          {open.length}
        </Badge>
      ) : null}
    </Link>
  );
};

/** The kinds of file read to check rather than to read: folded until opened. */
function foldedKind(file: Pick<Entry, 'category'>): boolean {
  return file.category === 'generated' || file.category === 'lockfile';
}

interface TopicReadingProps {
  context: ReadingContext;
  topic: Topic;
  next: Topic | undefined;
}

/** A topic: what it is at the top, then its parts of files, the code first and generated output folded. */
const TopicReading: FC<TopicReadingProps> = ({ context, topic, next }) => {
  const entries = topic.files.map(part =>
    part.whole || !part.patch
      ? fileEntry(part.file, foldedKind(part.file))
      : partEntry(part.file, part.patch, topic.id, foldedKind(part.file))
  );
  return (
    <Reading
      context={context}
      entries={entries}
      header={<TopicIntro review={context.review} topic={topic} viewer={context.viewer} />}
      footer={
        next ? (
          <div className="next-chapter">
            <Link to={`/pr/${context.review.pull.number}/files/${next.id}`}>Next: {next.title} →</Link>
          </div>
        ) : (
          <div className="next-chapter muted">That is the whole pull request.</div>
        )
      }
    />
  );
};

interface AllFilesProps {
  context: ReadingContext;
}

const fileOrder = { source: 0, migration: 1, contract: 2, generated: 3, lockfile: 4 };

/** Every changed file, as a tree beside their diffs: for reading file by file. */
const AllFiles: FC<AllFilesProps> = ({ context }) => {
  const files = context.review.files.toSorted(
    (a, b) => fileOrder[a.category] - fileOrder[b.category] || a.path.localeCompare(b.path)
  );
  return (
    <div className="flex min-h-0 flex-1">
      <div className="w-72 shrink-0 border-r border-border max-[900px]:hidden">
        <ChangeTree
          files={files}
          onOpen={path => context.viewer.current?.scrollTo({ type: 'item', id: path, align: 'start' })}
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <Reading
          context={context}
          entries={files.map(file => fileEntry(file, foldedKind(file)))}
          header={
            <header className="intro">
              <h2>All {files.length} files</h2>
              <p>Source code first, then migrations, contracts, generated output and the lockfile, folded.</p>
            </header>
          }
          footer={null}
        />
      </div>
    </div>
  );
};

interface ReadingProps {
  context: ReadingContext;
  entries: readonly Entry[];
  header: ReactNode;
  footer: ReactNode;
}

const Reading: FC<ReadingProps> = ({ context, entries, header, footer }) => (
  <DiffList
    review={context.review}
    entries={entries}
    viewer={context.viewer}
    viewed={context.viewed}
    drafts={context.drafts}
    diffStyle={context.diffStyle}
    wrap={context.wrap}
    header={header}
    footer={footer}
  />
);
