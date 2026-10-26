import { useSyncExternalStore, type FC } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { CheckState, Person, PullState } from '../../shared/review.ts';

interface AvatarProps {
  person: Person;
  size?: number;
}

export const Avatar: FC<AvatarProps> = ({ person, size = 20 }) => (
  <a href={person.url} className="avatar" title={person.login}>
    <img
      src={`${person.avatarUrl}${person.avatarUrl.includes('?') ? '&' : '?'}s=${size * 2}`}
      alt=""
      width={size}
      height={size}
    />
  </a>
);

const stateLabels = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' } satisfies Record<
  PullState,
  string
>;

interface StateBadgeProps {
  state: PullState;
  compact?: boolean;
}

export const StateBadge: FC<StateBadgeProps> = ({ state, compact = false }) => (
  <span className={`state state-${state}${compact ? ' compact' : ''}`} title={stateLabels[state]}>
    {compact ? '' : stateLabels[state]}
  </span>
);

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60]
];
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

// One clock for every relative time on the page, read to the minute so a render always sees the same value.
function subscribeToClock(onTick: () => void): () => void {
  const timer = setInterval(onTick, 30_000);
  return () => clearInterval(timer);
}

function currentMinute(): number {
  return Math.floor(Date.now() / 60_000) * 60_000;
}

interface RelativeTimeProps {
  iso: string;
}

export const RelativeTime: FC<RelativeTimeProps> = ({ iso }) => {
  const now = useSyncExternalStore(subscribeToClock, currentMinute);
  const date = new Date(iso);
  const seconds = (date.getTime() - now) / 1000;
  const [unit, size] = units.find(([, length]) => Math.abs(seconds) >= length) ?? ['minute', 60];
  return (
    <time dateTime={iso} title={date.toLocaleString()}>
      {Math.abs(seconds) < 60 ? 'just now' : relative.format(Math.round(seconds / size), unit)}
    </time>
  );
};

const checkSymbols = {
  success: '✓',
  failure: '✕',
  pending: '●',
  neutral: '–',
  skipped: '–'
} satisfies Record<CheckState, string>;

interface CheckMarkProps {
  state: CheckState;
}

export const CheckMark: FC<CheckMarkProps> = ({ state }) => (
  <span className={`check-mark check-${state}`} aria-label={state}>
    {checkSymbols[state]}
  </span>
);

// Raw HTML in a body is shown as text, not rendered: anyone may comment on a public repository.
const markdownComponents: Components = {
  a: ({ href, title, children }) => (
    <a href={href} title={title} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
};

interface MarkdownBodyProps {
  text: string;
}

export const MarkdownBody: FC<MarkdownBodyProps> = ({ text }) =>
  text.trim() ? (
    <div className="markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </Markdown>
    </div>
  ) : (
    <p className="muted">No description provided.</p>
  );
