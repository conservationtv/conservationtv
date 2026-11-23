import { Badge } from '@conservationtv/ui/components/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@conservationtv/ui/components/card';
import { cn } from '@conservationtv/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import type { FC } from 'react';
import type { Deploy, ServiceHealth, Window } from '../../shared/deploys.ts';
import type { CheckState, Review } from '../../shared/review.ts';
import { deploysQuery } from '../api.ts';
import { formatCount } from '../format.ts';
import { CheckMark, RelativeTime } from './common.tsx';

// Where a merged pull request went: each environment's first deploy that carried it, and how each traced service did
// in the hour before it finished and the hour after, from Grafana Cloud.

const deployStates = new Map<string, CheckState>([
  ['success', 'success'],
  ['failure', 'failure'],
  ['error', 'failure'],
  ['inactive', 'neutral']
]);

function exceptionsOf(window: Window): number {
  return window.exceptions.reduce((sum, each) => sum + each.count, 0);
}

function milliseconds(seconds: number | null): string {
  return seconds === null ? '–' : `${Math.round(seconds * 1000)} ms`;
}

interface ChangeProps {
  label: string;
  before: string;
  after: string;
  /** The after is worse: more failures, or slower. */
  worse: boolean;
}

const Change: FC<ChangeProps> = ({ label, before, after, worse }) => (
  <>
    <span className="text-muted-foreground">{label}</span>
    <span className="text-right font-mono text-muted-foreground">{before}</span>
    <span className={cn('text-right font-mono', worse && 'font-semibold text-destructive')}>{after}</span>
  </>
);

interface HealthProps {
  health: ServiceHealth;
}

/** A service an hour either side of the deploy: requests, 5xx, exceptions and p95, and what it newly threw. */
const Health: FC<HealthProps> = ({ health }) => {
  const { before, after } = health;
  // An hour after can be shorter than one before, while it is still under way: failures compare as shares.
  const share = (count: number, window: Window) => (window.requests ? count / window.requests : 0);
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border p-2 text-xs">
      <p className="flex items-center justify-between gap-2">
        <code>{health.service}</code>
        <a href={health.explore} target="_blank" rel="noreferrer">
          Traces ↗
        </a>
      </p>
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-3">
        <span />
        <span className="text-right text-muted-foreground">before</span>
        <span className="text-right text-muted-foreground">after</span>
        <Change
          label="Requests"
          before={formatCount(before.requests)}
          after={formatCount(after.requests)}
          worse={false}
        />
        <Change
          label="5xx"
          before={formatCount(before.serverErrors)}
          after={formatCount(after.serverErrors)}
          worse={share(after.serverErrors, after) > share(before.serverErrors, before)}
        />
        <Change
          label="Exceptions"
          before={formatCount(exceptionsOf(before))}
          after={formatCount(exceptionsOf(after))}
          worse={share(exceptionsOf(after), after) > share(exceptionsOf(before), before) * 1.5}
        />
        <Change
          label="p95"
          before={milliseconds(before.p95)}
          after={milliseconds(after.p95)}
          worse={after.p95 !== null && before.p95 !== null && after.p95 > before.p95 * 1.25}
        />
      </div>
      {health.newExceptions.length ? (
        <ul className="mt-1 flex flex-col gap-0.5">
          {health.newExceptions.map(message => (
            <li key={message} className="text-destructive">
              New: {message || 'an exception without a message'}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};

interface DeployRowProps {
  deploy: Deploy;
}

/** A deploy: its state, environment, workflow and commit, then each traced service's hour either side. */
const DeployRow: FC<DeployRowProps> = ({ deploy }) => (
  <li className="flex flex-col gap-1.5">
    <p className="flex flex-wrap items-center gap-1.5">
      <CheckMark state={deployStates.get(deploy.state) ?? 'pending'} />
      <Badge variant="outline">{deploy.environment}</Badge>
      {deploy.workflow ? <span className="text-muted-foreground">{deploy.workflow}</span> : null}
      <code className="text-xs text-muted-foreground">{deploy.sha.slice(0, 7)}</code>
      {deploy.url ? (
        <a href={deploy.url} className="ml-auto text-xs">
          <RelativeTime iso={deploy.updatedAt} />
        </a>
      ) : null}
    </p>
    {deploy.health === null ? (
      <p className="text-xs text-muted-foreground">Grafana isn't set up for the review tool.</p>
    ) : deploy.health.length ? (
      deploy.health.map(health => <Health key={health.service} health={health} />)
    ) : (
      <p className="text-xs text-muted-foreground">No service of {deploy.environment} sends traces.</p>
    )}
  </li>
);

interface DeploysCardProps {
  review: Review;
}

/** Nothing until the pull request is merged; then where it went, as each deploy carrying it is found. */
// Unmerged, nothing; then loading, failing, nowhere yet, or each deploy found.
export const DeploysCard: FC<DeploysCardProps> = ({ review }) => {
  const merged = review.pull.state === 'merged';
  const { data, error, isPending } = useQuery({ ...deploysQuery(review.pull.number), enabled: merged });
  if (!merged) return null;
  return (
    <Card size="sm" className="gap-2 text-[13px]">
      <CardHeader>
        <CardTitle>Deploys</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {isPending ? <p className="text-muted-foreground">Finding the deploys that carried it…</p> : null}
        {error ? <p className="text-xs text-destructive">{error.message}</p> : null}
        {data && !data.deploys.length ? <p className="text-muted-foreground">Not deployed anywhere yet.</p> : null}
        {data?.deploys.length ? (
          <ol className="flex flex-col gap-3">
            {data.deploys.map(deploy => (
              <DeployRow key={`${deploy.environment}:${deploy.sha}`} deploy={deploy} />
            ))}
          </ol>
        ) : null}
      </CardContent>
    </Card>
  );
};
