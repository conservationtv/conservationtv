import { Avatar as AvatarRoot, AvatarFallback, AvatarImage } from '@conservationtv/ui/components/avatar';
import { Badge } from '@conservationtv/ui/components/badge';
import { cn } from '@conservationtv/ui/lib/utils';
import { CheckIcon, CircleIcon, MinusIcon, XIcon, type Icon } from '@phosphor-icons/react';
import { useSyncExternalStore, type FC, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkAlerts, remarkDetails } from '../markdown.ts';
import type { CheckState, ContractChange, Person, PullState } from '../../shared/review.ts';

interface AvatarProps {
  person: Person;
  size?: number;
  className?: string;
}

export const Avatar: FC<AvatarProps> = ({ person, size = 20, className }) => (
  <a href={person.url} title={person.login} className={cn('shrink-0', className)}>
    <AvatarRoot style={{ width: size, height: size }}>
      <AvatarImage src={`${person.avatarUrl}${person.avatarUrl.includes('?') ? '&' : '?'}s=${size * 2}`} alt="" />
      <AvatarFallback className="text-[0.6rem]">{person.login.slice(0, 1).toUpperCase()}</AvatarFallback>
    </AvatarRoot>
  </a>
);

const stateLabels = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' } satisfies Record<
  PullState,
  string
>;

const stateColours = {
  open: 'bg-(--success)',
  draft: 'bg-(--draft)',
  merged: 'bg-(--merged)',
  closed: 'bg-destructive'
} satisfies Record<PullState, string>;

interface StateBadgeProps {
  state: PullState;
  /** A dot, where there is room only for the colour. */
  compact?: boolean;
  className?: string;
}

export const StateBadge: FC<StateBadgeProps> = ({ state, compact = false, className }) =>
  compact ? (
    <span
      className={cn('inline-block size-2.5 shrink-0 rounded-full', stateColours[state], className)}
      title={stateLabels[state]}
      role="img"
      aria-label={stateLabels[state]}
    />
  ) : (
    <Badge className={cn('h-6 px-2.5 text-xs text-white max-[900px]:h-5', stateColours[state], className)}>
      {stateLabels[state]}
    </Badge>
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

/** How a check result is drawn. */
interface CheckLook {
  icon: Icon;
  colour: string;
}

const checkIcons = {
  success: { icon: CheckIcon, colour: 'text-(--success)' },
  failure: { icon: XIcon, colour: 'text-destructive' },
  pending: { icon: CircleIcon, colour: 'text-(--warning)' },
  neutral: { icon: MinusIcon, colour: 'text-muted-foreground' },
  skipped: { icon: MinusIcon, colour: 'text-muted-foreground' }
} satisfies Record<CheckState, CheckLook>;

interface CheckMarkProps {
  state: CheckState;
}

export const CheckMark: FC<CheckMarkProps> = ({ state }) => {
  const { icon: StateIcon, colour } = checkIcons[state];
  return (
    <StateIcon
      className={cn('inline-block size-3.5 shrink-0 self-center', colour)}
      weight={state === 'pending' ? 'fill' : 'bold'}
      aria-label={state}
    />
  );
};

/** A contract change's kind, by how far it reaches: new is safe, changed and removed break clients. */
const contractColours = {
  added: 'text-(--success)',
  changed: 'text-(--warning)',
  removed: 'text-destructive'
} satisfies Record<ContractChange['kind'], string>;

interface ContractKindBadgeProps {
  kind: ContractChange['kind'];
  children: ReactNode;
}

export const ContractKindBadge: FC<ContractKindBadgeProps> = ({ kind, children }) => (
  <Badge variant="outline" className={cn('rounded-sm border-current bg-transparent', contractColours[kind])}>
    {children}
  </Badge>
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
      <Markdown remarkPlugins={[remarkGfm, remarkAlerts, remarkDetails]} components={markdownComponents}>
        {text}
      </Markdown>
    </div>
  ) : (
    <p className="text-muted-foreground">No description provided.</p>
  );
