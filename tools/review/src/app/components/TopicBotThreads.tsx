import { Badge } from '@conservationtv/ui/components/badge';
import { Button } from '@conservationtv/ui/components/button';
import { cn } from '@conservationtv/ui/lib/utils';
import { ArrowDownIcon } from '@phosphor-icons/react';
import { useState, type FC } from 'react';
import { isReviewBot, reviewBots } from '../../shared/bots.ts';
import type { Thread } from '../../shared/review.ts';
import { Avatar, MarkdownBody } from './common.tsx';
import type { Viewer } from './DiffList.tsx';

// A review bot's threads on a topic, at its very top: what Pullfrog said about this part of the change, open threads
// first, each with a way down to the code it is on, where the thread sits inline in the diff.

interface BotThreadProps {
  thread: Thread;
  viewer: Viewer;
}

/** The place a thread is on: its file and line, or that the code has since changed. */
function placeOf(thread: Thread): string {
  const file = thread.path.split('/').at(-1) ?? thread.path;
  return thread.line === null ? `${file}, since changed` : `${file}:${thread.line}`;
}

/** One thread: who, where, its first comment (clipped until asked for), and a jump to its line in the diff below. */
const BotThread: FC<BotThreadProps> = ({ thread, viewer }) => {
  const [whole, setWhole] = useState(false);
  const [first] = thread.comments;
  if (!first) return null;
  const replies = thread.comments.length - 1;
  const jump = () => {
    // To the line, centred, where the thread is shown inline; a thread on code that has since changed, to its file.
    const target =
      thread.line === null
        ? ({ type: 'item', id: thread.path, align: 'start' } as const)
        : ({ type: 'line', id: thread.path, lineNumber: thread.line, side: thread.side, align: 'center' } as const);
    viewer.current?.scrollTo(target);
  };
  return (
    <li className={cn('flex flex-col gap-2 rounded-lg border border-border p-3', thread.resolved && 'opacity-70')}>
      <header className="flex flex-wrap items-center gap-2 text-xs">
        <Avatar person={first.author} />
        <strong className="text-[13px]">{reviewBots.get(first.author.login) ?? first.author.login}</strong>
        <code className="text-muted-foreground" title={thread.path}>
          {placeOf(thread)}
        </code>
        {thread.resolved ? <Badge variant="secondary">Resolved</Badge> : null}
        {replies ? (
          <span className="text-muted-foreground">
            {replies} repl{replies === 1 ? 'y' : 'ies'}
          </span>
        ) : null}
        <Button variant="outline" size="sm" className="ml-auto" onClick={jump}>
          <ArrowDownIcon data-icon="inline-start" />
          Jump to code
        </Button>
      </header>
      <div className={cn('relative text-[13px]', !whole && 'max-h-40 overflow-hidden')}>
        <MarkdownBody text={first.body} />
        {whole ? null : (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-linear-to-t from-background" />
        )}
      </div>
      <Button variant="link" size="xs" className="self-start p-0" onClick={() => setWhole(current => !current)}>
        {whole ? 'Show less' : 'Show all'}
      </Button>
    </li>
  );
};

interface TopicBotThreadsProps {
  threads: readonly Thread[];
  viewer: Viewer;
}

/** The topic's threads a review bot started, open ones first; nothing when it has none. */
export const TopicBotThreads: FC<TopicBotThreadsProps> = ({ threads, viewer }) => {
  const fromBots = threads
    .filter(thread => isReviewBot(thread.comments[0]?.author.login ?? ''))
    .toSorted((a, b) => Number(a.resolved === true) - Number(b.resolved === true));
  if (!fromBots.length) return null;
  return (
    <ol className="flex flex-col gap-2" aria-label="Review bots on this topic">
      {fromBots.map(thread => (
        <BotThread key={thread.comments[0]?.id} thread={thread} viewer={viewer} />
      ))}
    </ol>
  );
};
