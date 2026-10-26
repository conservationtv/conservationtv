import { useQuery } from '@tanstack/react-query';
import type { FC } from 'react';
import type { Review } from '../../shared/review.ts';
import { pullQueries } from '../api.ts';
import { Account } from '../components/Account.tsx';
import { Avatar, RelativeTime, StateBadge } from '../components/common.tsx';
import { ConversationView } from '../components/ConversationView.tsx';
import { ReviewView } from '../components/ReviewView.tsx';
import { StackBar } from '../components/StackBar.tsx';
import { WeightBar } from '../components/WeightBar.tsx';
import { weigh } from '../weights.ts';
import { Link } from '../components/Link.tsx';

interface PullHeaderProps {
  review: Review;
  tab: Tab;
}

interface PullBylineProps {
  review: Review;
}

/** Who wants what merged where, and when: on the conversation, where there is room for it. */
const PullByline: FC<PullBylineProps> = ({ review }) => {
  const { pull } = review;
  const commits = `${pull.commits} commit${pull.commits === 1 ? '' : 's'}`;
  return (
    <div className="pull-byline">
      <Avatar person={pull.author} />
      <span>
        <strong>{pull.author.login}</strong>{' '}
        <span className="byline-detail">
          {pull.state === 'merged' ? 'merged' : 'wants to merge'} {commits} into{' '}
          <code className="ref">{pull.baseRef}</code> from <code className="ref">{pull.headRef}</code>
        </span>{' '}
        · <RelativeTime iso={pull.updatedAt} />
      </span>
    </div>
  );
};

/**
 * The title on one line, then the tabs beside its stack and how much of the change there is to read: kept short so
 * the review below has the screen.
 */
const PullHeader: FC<PullHeaderProps> = ({ review, tab }) => {
  const { pull } = review;
  const comments = review.conversation.length + review.threads.length;
  return (
    <header className="pull-header">
      <div className="pull-title">
        <Link to="/" className="back" title="Pull requests">
          ←
        </Link>
        <StateBadge state={pull.state} />
        <h1 title={pull.title}>
          {pull.title} <span className="muted">#{pull.number}</span>
        </h1>
        <a href={pull.url} className="muted github-link">
          GitHub ↗
        </a>
        {/* Opens the pull request in T3 Code, to work on it there. */}
        <a href={`t3code://new?pr=${review.repository}/${pull.number}`} className="muted github-link">
          T3 ↗
        </a>
        <Account />
      </div>
      {tab === 'conversation' && <PullByline review={review} />}
      <div className="pull-bar">
        <nav className="tabs">
          <Link to={`/pr/${pull.number}`} className={tab === 'conversation' ? 'tab active' : 'tab'}>
            Conversation <span className="count">{comments}</span>
          </Link>
          <Link to={`/pr/${pull.number}/files`} className={tab === 'files' ? 'tab active' : 'tab'}>
            Review <span className="count">{review.files.length} files</span>
          </Link>
        </nav>
        <StackBar stack={review.stack} current={pull.number} tab={tab} />
        <WeightBar weights={weigh(review.files)} />
      </div>
    </header>
  );
};

export type Tab = 'conversation' | 'files';

interface PullPageProps {
  number: number;
  tab: Tab;
  chapter: string | undefined;
  operation: string | undefined;
}

export const PullPage: FC<PullPageProps> = ({ number, tab, chapter, operation }) => {
  const { data, error, isPending } = useQuery(pullQueries.review(number));
  if (isPending) return <main className="page narrow muted">Loading #{number}…</main>;
  if (error) {
    return (
      <main className="page narrow">
        <p className="error-box">{error.message}</p>
        <Link to="/">← Pull requests</Link>
      </main>
    );
  }
  return (
    <div className={tab === 'files' ? 'shell files-shell' : 'shell'}>
      <PullHeader review={data} tab={tab} />
      {/* Keyed by number: folds and viewed files belong to one pull request, not the next one in its stack. */}
      {tab === 'files' ? (
        <ReviewView key={number} review={data} chapter={chapter} operation={operation} />
      ) : (
        <ConversationView review={data} />
      )}
    </div>
  );
};
