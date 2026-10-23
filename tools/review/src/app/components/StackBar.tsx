import type { FC } from 'react';
import type { StackEntry } from '../../shared/review.ts';
import type { Tab } from '../pages/PullPage.tsx';
import { Link } from './Link.tsx';
import { StateBadge } from './common.tsx';

interface StackBarProps {
  stack: readonly StackEntry[];
  current: number;
  tab: Tab;
}

/** The stack this pull request is part of, bottom first: each one is reviewed against the branch below it. */
export const StackBar: FC<StackBarProps> = ({ stack, current, tab }) => {
  if (!stack.length) return null;
  return (
    <nav className="stack" aria-label="Stack">
      <span className="stack-label">Stack</span>
      <ol>
        {stack.map(entry => (
          <li key={entry.number} className={entry.number === current ? 'current' : undefined}>
            <StateBadge state={entry.state} compact />
            <Link to={`/pr/${entry.number}${tab === 'files' ? '/files' : ''}`} title={entry.title}>
              <span className="muted">#{entry.number}</span> {entry.title}
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
};
