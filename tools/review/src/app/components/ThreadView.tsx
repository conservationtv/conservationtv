import type { FC } from 'react';
import type { Thread } from '../../shared/review.ts';
import { Avatar, MarkdownBody, RelativeTime } from './common.tsx';

interface ThreadViewProps {
  thread: Thread;
}

/** A line comment and its replies. Replying happens on GitHub: this tool only reads. */
export const ThreadView: FC<ThreadViewProps> = ({ thread }) => {
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
      {last ? (
        <a className="thread-reply" href={last.url}>
          Reply on GitHub ↗
        </a>
      ) : null}
    </div>
  );
};
