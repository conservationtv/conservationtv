import { Badge } from '@conservationtv/ui/components/badge';
import { Button } from '@conservationtv/ui/components/button';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FC } from 'react';
import { isReviewBot, reviewBots } from '../../shared/bots.ts';
import type { Thread, ThreadComment } from '../../shared/review.ts';
import { refreshReview, send } from '../api.ts';
import { useSession } from '../session.ts';
import { Avatar, MarkdownBody, RelativeTime } from './common.tsx';
import { Composer } from './Composer.tsx';

interface ThreadViewProps {
  number: number;
  thread: Thread;
}

/**
 * A line comment and its replies, and a reply as the signed-in reviewer; on GitHub for anyone else. A resolved thread
 * folds to one line, as it needs nothing more.
 */
export const ThreadView: FC<ThreadViewProps> = ({ number, thread }) => {
  const [open, setOpen] = useState(thread.resolved !== true);
  return (
    <div className="thread">
      <ThreadBar number={number} thread={thread} open={open} onOpen={setOpen} />
      {open ? (
        <>
          {thread.comments.map(comment => (
            <CommentView key={comment.id} comment={comment} />
          ))}
          <ThreadReply number={number} thread={thread} />
        </>
      ) : null}
    </div>
  );
};

interface ThreadBarProps {
  number: number;
  thread: Thread;
  open: boolean;
  onOpen(open: boolean): void;
}

/** What state the thread is in, and folding it or resolving it; nothing when there is none of that to show. */
const ThreadBar: FC<ThreadBarProps> = ({ number, thread, open, onOpen }) => {
  const session = useSession();
  const canResolve = Boolean(session?.viewer) && thread.id !== null;
  if (!thread.resolved && thread.line !== null && !canResolve) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
      {thread.line === null ? <span>On code that has since changed</span> : null}
      {thread.resolved ? <ResolvedFold thread={thread} open={open} onOpen={onOpen} /> : null}
      {canResolve ? <ResolveButton number={number} thread={thread} onOpen={onOpen} /> : null}
    </div>
  );
};

interface ResolvedFoldProps {
  thread: Thread;
  open: boolean;
  onOpen(open: boolean): void;
}

/** A resolved thread: marked so, its first line while folded, and a way to show it whole. */
const ResolvedFold: FC<ResolvedFoldProps> = ({ thread, open, onOpen }) => {
  const [first] = thread.comments;
  return (
    <>
      <Badge variant="secondary">Resolved</Badge>
      <span className="min-w-0 flex-1 truncate">
        {!open && first ? `${first.author.login}: ${first.body.split('\n')[0]}` : null}
      </span>
      <Button variant="ghost" size="xs" onClick={() => onOpen(!open)}>
        {open ? 'Fold' : 'Show'}
      </Button>
    </>
  );
};

interface ResolveButtonProps {
  number: number;
  thread: Thread;
  onOpen(open: boolean): void;
}

/** Resolving the thread as the signed-in reviewer, or opening it again; folded once resolved. */
const ResolveButton: FC<ResolveButtonProps> = ({ number, thread, onOpen }) => {
  const queryClient = useQueryClient();
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resolve(resolved: boolean) {
    setResolving(true);
    setError(null);
    try {
      await send(`/api/pulls/${number}/threads/${thread.id}/resolve`, { resolved });
      await refreshReview(queryClient, number);
      onOpen(!resolved);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That did not go through.');
    } finally {
      setResolving(false);
    }
  }

  return (
    <>
      {error ? <span className="text-destructive">{error}</span> : null}
      <Button
        variant="ghost"
        size="xs"
        className="ml-auto"
        loading={resolving}
        onClick={() => void resolve(!thread.resolved)}
      >
        {thread.resolved ? 'Reopen' : 'Resolve'}
      </Button>
    </>
  );
};

interface CommentViewProps {
  comment: ThreadComment;
}

/** One comment in a thread; a review bot's by its name, marked as a bot. */
const CommentView: FC<CommentViewProps> = ({ comment }) => (
  <article className="thread-comment">
    <header>
      <Avatar person={comment.author} />
      <strong>{reviewBots.get(comment.author.login) ?? comment.author.login}</strong>
      {isReviewBot(comment.author.login) ? <Badge variant="outline">bot</Badge> : null}
      <a href={comment.url} className="muted">
        <RelativeTime iso={comment.createdAt} />
      </a>
    </header>
    <MarkdownBody text={comment.body} />
  </article>
);

interface ThreadReplyProps {
  number: number;
  thread: Thread;
}

/** A reply as the signed-in reviewer, or a way to reply on GitHub. */
const ThreadReply: FC<ThreadReplyProps> = ({ number, thread }) => {
  const session = useSession();
  const queryClient = useQueryClient();
  const [replying, setReplying] = useState(false);
  const [first] = thread.comments;
  const last = thread.comments.at(-1);
  if (!session?.viewer) {
    return last ? (
      <a className="thread-reply" href={last.url}>
        Reply on GitHub ↗
      </a>
    ) : null;
  }
  if (!replying || !first) {
    return (
      <Button variant="link" size="sm" className="thread-reply" onClick={() => setReplying(true)}>
        Reply…
      </Button>
    );
  }
  return (
    <div className="thread-composer">
      <Composer
        placeholder="Reply (Markdown)"
        autoFocus
        onCancel={() => setReplying(false)}
        actions={[
          {
            label: 'Reply',
            primary: true,
            run: async body => {
              // Replies go to the thread's first comment, as GitHub threads them.
              await send(`/api/pulls/${number}/comments/${first.id}/replies`, { body });
              await refreshReview(queryClient, number);
              setReplying(false);
            }
          }
        ]}
      />
    </div>
  );
};
