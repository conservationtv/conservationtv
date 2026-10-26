import { useQueryClient } from '@tanstack/react-query';
import { useState, type FC } from 'react';
import type { Thread } from '../../shared/review.ts';
import { refreshReview, send } from '../api.ts';
import { useSession } from '../session.ts';
import { Avatar, MarkdownBody, RelativeTime } from './common.tsx';
import { Composer } from './Composer.tsx';

interface ThreadViewProps {
  number: number;
  thread: Thread;
}

/** A line comment and its replies, and a reply as the signed-in reviewer; on GitHub for anyone else. */
export const ThreadView: FC<ThreadViewProps> = ({ number, thread }) => {
  const session = useSession();
  const queryClient = useQueryClient();
  const [replying, setReplying] = useState(false);
  const [first] = thread.comments;
  const last = thread.comments.at(-1);
  return (
    <div className="thread">
      {thread.line === null ? <p className="muted small">On code that has since changed</p> : null}
      {thread.comments.map(comment => (
        <article key={comment.id} className="thread-comment">
          <header>
            <Avatar person={comment.author} />
            <strong>{comment.author.login}</strong>
            <a href={comment.url} className="muted">
              <RelativeTime iso={comment.createdAt} />
            </a>
          </header>
          <MarkdownBody text={comment.body} />
        </article>
      ))}
      {replying && first ? (
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
      ) : null}
      {!replying && session?.viewer ? (
        <button type="button" className="thread-reply link-button" onClick={() => setReplying(true)}>
          Reply…
        </button>
      ) : null}
      {!session?.viewer && last ? (
        <a className="thread-reply" href={last.url}>
          Reply on GitHub ↗
        </a>
      ) : null}
    </div>
  );
};
