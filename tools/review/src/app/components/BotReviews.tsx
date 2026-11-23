import { Badge } from '@conservationtv/ui/components/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@conservationtv/ui/components/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@conservationtv/ui/components/collapsible';
import { cn } from '@conservationtv/ui/lib/utils';
import { CaretRightIcon, CheckCircleIcon, InfoIcon, WarningCircleIcon, type Icon } from '@phosphor-icons/react';
import type { FC } from 'react';
import {
  hasSuggestion,
  reviewBots,
  verdictOf,
  type BotReport,
  type BotReview,
  type VerdictTone
} from '../../shared/bots.ts';
import type { ConversationEntry, Review, Thread } from '../../shared/review.ts';
import { topicOfThread } from '../topics.ts';
import { useTopics } from '../use-topics.ts';
import { Avatar, MarkdownBody, RelativeTime } from './common.tsx';
import { Link } from './Link.tsx';

// What the review bots (src/shared/bots.ts) have said, read for the verdict and what is still open: a card beside the
// conversation, and each of their reviews folded to its verdict in it.

interface ToneLook {
  label: string;
  icon: Icon;
  colour: string;
}

const tones = {
  clean: { label: 'No issues', icon: CheckCircleIcon, colour: 'text-(--success)' },
  notes: { label: 'Notes', icon: InfoIcon, colour: 'text-(--cat-source)' },
  attention: { label: 'Needs attention', icon: WarningCircleIcon, colour: 'text-(--warning)' }
} satisfies Record<VerdictTone, ToneLook>;

interface VerdictBadgeProps {
  tone: VerdictTone;
}

export const VerdictBadge: FC<VerdictBadgeProps> = ({ tone }) => {
  const { label, icon: ToneIcon, colour } = tones[tone];
  return (
    <Badge variant="outline" className={cn('border-current bg-transparent', colour)}>
      <ToneIcon weight="fill" data-icon="inline-start" />
      {label}
    </Badge>
  );
};

interface CommitRefProps {
  sha: string | null;
  head: string;
}

/** The commit a review was of, and whether the branch has moved on since. */
const CommitRef: FC<CommitRefProps> = ({ sha, head }) => {
  if (!sha) return <span className="text-muted-foreground">a commit since rewritten</span>;
  return (
    <span className={sha === head ? undefined : 'text-muted-foreground'}>
      <code>{sha.slice(0, 7)}</code>
      {sha === head ? ' (head)' : ''}
    </span>
  );
};

/** Where a thread is: its file and line, or that the code it was on has changed. */
function threadPlace(thread: Thread): string {
  const file = thread.path.split('/').at(-1) ?? thread.path;
  return thread.line === null ? `${file}, outdated` : `${file}:${thread.line}`;
}

/** The first sentence of a comment, as plain as Markdown allows without rendering it. */
function gist(body: string): string {
  const text = body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[*_`>#]/g, '')
    .trim();
  const sentence = text.match(/^.*?[.!?](\s|$)/)?.[0] ?? text;
  return sentence.length > 140 ? `${sentence.slice(0, 139)}…` : sentence;
}

interface ThreadLinkProps {
  review: Review;
  thread: Thread;
}

/** A thread as one line, opening the chapter its file is in. */
const ThreadLink: FC<ThreadLinkProps> = ({ review, thread }) => {
  const topics = useTopics(review);
  const topic = topics ? topicOfThread(topics, thread) : null;
  const [first] = thread.comments;
  return (
    <li className="flex flex-col gap-0.5 py-1">
      <span className="flex items-center gap-1.5">
        <Link to={`/pr/${review.pull.number}/files/${topic ?? ''}`} title={thread.path}>
          <code>{threadPlace(thread)}</code>
        </Link>
        {first && hasSuggestion(first.body) ? <Badge variant="secondary">Suggestion</Badge> : null}
        {thread.comments.length > 1 ? (
          <span className="text-muted-foreground">
            {thread.comments.length - 1} repl{thread.comments.length === 2 ? 'y' : 'ies'}
          </span>
        ) : null}
      </span>
      {first ? <span className="text-xs text-muted-foreground">{gist(first.body)}</span> : null}
    </li>
  );
};

interface VerdictHistoryProps {
  reviews: readonly BotReview[];
  head: string;
}

/** A bot's verdict push by push, oldest first. */
const VerdictHistory: FC<VerdictHistoryProps> = ({ reviews, head }) => (
  <>
    <h4 className="mt-1 text-xs font-semibold text-muted-foreground">Push by push</h4>
    <ol className="flex flex-col gap-0.5">
      {reviews.map(({ entry, verdict }) => {
        if (!verdict) return null;
        const { icon: ToneIcon, colour } = tones[verdict.tone];
        return (
          <li key={entry.id} className="flex items-center gap-1.5" title={verdict.summary.replaceAll('`', '')}>
            <ToneIcon weight="fill" className={cn('size-3.5 shrink-0', colour)} />
            <a href={entry.url} className="text-foreground">
              <CommitRef sha={entry.commitId} head={head} />
            </a>
            <span className="truncate text-muted-foreground">{verdict.summary.replaceAll('`', '')}</span>
          </li>
        );
      })}
    </ol>
  </>
);

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** How many threads are open and resolved; only how many there are when GraphQL couldn't say. */
function threadCount(threads: readonly Thread[], open: readonly Thread[]): string {
  const known = threads.every(thread => thread.resolved !== null);
  if (!known) return plural(threads.length, 'thread');
  return `${plural(open.length, 'open thread')} · ${threads.length - open.length} resolved`;
}

interface BotCardProps {
  review: Review;
  report: BotReport;
}

/**
 * A review bot at a glance: its latest verdict and the commit it was of, the threads it opened that are still open, and
 * how its verdict went push by push.
 */
export const BotCard: FC<BotCardProps> = ({ review, report }) => {
  const history = report.reviews.filter(entry => entry.verdict !== null);
  const latest = history.at(-1);
  const open = report.threads.filter(thread => thread.resolved !== true);
  return (
    <Card size="sm" className="gap-2 text-[13px]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {report.name}
          {latest?.verdict ? <VerdictBadge tone={latest.verdict.tone} /> : null}
        </CardTitle>
        {latest ? (
          <CardDescription>
            Of <CommitRef sha={latest.entry.commitId} head={review.pull.headSha} />,{' '}
            <RelativeTime iso={latest.entry.createdAt} />
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {latest?.verdict ? <MarkdownBody text={latest.verdict.summary} /> : null}
        <h4 className="mt-1 text-xs font-semibold text-muted-foreground">{threadCount(report.threads, open)}</h4>
        {open.length ? (
          <ul className="divide-y divide-border">
            {open.map(thread => (
              <ThreadLink key={thread.comments[0]?.id} review={review} thread={thread} />
            ))}
          </ul>
        ) : null}
        {history.length > 1 ? <VerdictHistory reviews={history} head={review.pull.headSha} /> : null}
      </CardContent>
    </Card>
  );
};

interface BotEntryProps {
  entry: ConversationEntry;
  head: string;
}

/**
 * A review bot's review in the conversation, folded to its verdict: it reviews every push, and the detail matters
 * only until the next one.
 */
export const BotEntry: FC<BotEntryProps> = ({ entry, head }) => {
  const verdict = verdictOf(entry.body);
  const name = reviewBots.get(entry.author.login) ?? entry.author.login;
  return (
    <Collapsible className="entry">
      <header className="flex-wrap">
        <Avatar person={entry.author} size={24} />
        <strong>{name}</strong>
        <span className="muted">
          reviewed <CommitRef sha={entry.commitId} head={head} />
        </span>
        <a href={entry.url} className="muted">
          <RelativeTime iso={entry.createdAt} />
        </a>
        {verdict ? <VerdictBadge tone={verdict.tone} /> : null}
      </header>
      {verdict ? (
        <div className="px-4 pt-2">
          <MarkdownBody text={verdict.summary} />
        </div>
      ) : null}
      <CollapsibleTrigger className="group flex items-center gap-1 px-4 py-2 text-xs text-muted-foreground hover:text-foreground">
        <CaretRightIcon className="size-3 transition-transform group-data-panel-open:rotate-90" />
        The whole review
      </CollapsibleTrigger>
      <CollapsibleContent className="px-4 pb-3">
        <MarkdownBody text={entry.body} />
      </CollapsibleContent>
    </Collapsible>
  );
};
