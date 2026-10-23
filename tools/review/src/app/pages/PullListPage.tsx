import { useQuery } from '@tanstack/react-query';
import type { FC } from 'react';
import type { PullSummary } from '../../shared/review.ts';
import { pullQueries } from '../api.ts';
import { Avatar, RelativeTime, StateBadge } from '../components/common.tsx';
import { Link } from '../components/Link.tsx';

interface PullRowProps {
  pull: PullSummary;
  depth?: number;
}

const PullRow: FC<PullRowProps> = ({ pull, depth = 0 }) => (
  <li className="pull-row" style={{ paddingLeft: `calc(${depth} * 1.5rem + 0.75rem)` }}>
    {depth > 0 ? <span className="stack-elbow" aria-hidden /> : null}
    <StateBadge state={pull.state} compact />
    <div className="pull-body">
      <Link to={`/pr/${pull.number}/files`} className="pull-title">
        {pull.title} <span className="muted">#{pull.number}</span>
      </Link>
      <span className="pull-meta">
        <code className="ref">{pull.headRef}</code>
        <Avatar person={pull.author} />
        <RelativeTime iso={pull.updatedAt} />
      </span>
    </div>
  </li>
);

export const PullListPage: FC = () => {
  const { data, error, isPending } = useQuery(pullQueries.list());
  if (isPending) return <main className="page narrow muted">Loading pull requests…</main>;
  if (error) return <main className="page narrow error-box">{error.message}</main>;
  return (
    <main className="page narrow">
      <header className="list-header">
        <h1>Pull requests</h1>
        <a className="muted" href={`https://github.com/${data.repository}/pulls`}>
          {data.repository} on GitHub ↗
        </a>
      </header>
      <section>
        <h2>Open</h2>
        {data.open.length ? (
          <ul className="pull-list">
            {data.open.map(pull => (
              <PullRow key={pull.number} pull={pull} depth={pull.depth} />
            ))}
          </ul>
        ) : (
          <p className="muted">Nothing open.</p>
        )}
      </section>
      <section>
        <h2>Recently closed</h2>
        <ul className="pull-list">
          {data.recent.map(pull => (
            <PullRow key={pull.number} pull={pull} />
          ))}
        </ul>
      </section>
    </main>
  );
};
