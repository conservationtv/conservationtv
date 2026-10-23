import { useQuery } from '@tanstack/react-query';
import type { FC } from 'react';
import type { Review } from '../../shared/review.ts';
import { pullQueries } from '../api.ts';
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

/** The title, who wants what merged where, its stack, and the tabs with how much of the change there is to read. */
const PullHeader: FC<PullHeaderProps> = ({ review, tab }) => {
  const { pull } = review;
  const commits = `${pull.commits} commit${pull.commits === 1 ? '' : 's'}`;
  const comments = review.conversation.length + review.threads.length;
  return (
    <header className="pull-header">
      <div className="crumbs">
        <Link to="/">← Pull requests</Link>
        <a href={pull.url} className="muted">
          Open on GitHub ↗
        </a>
      </div>
      <h1>
        {pull.title} <span className="muted">#{pull.number}</span>
      </h1>
      <div className="pull-byline">
        <StateBadge state={pull.state} />
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
      <StackBar stack={review.stack} current={pull.number} tab={tab} />
      <nav className="tabs">
        <Link to={`/pr/${pull.number}`} className={tab === 'conversation' ? 'tab active' : 'tab'}>
          Conversation <span className="count">{comments}</span>
        </Link>
        <Link to={`/pr/${pull.number}/files`} className={tab === 'files' ? 'tab active' : 'tab'}>
          Review <span className="count">{review.files.length} files</span>
        </Link>
        <WeightBar weights={weigh(review.files)} />
      </nav>
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
