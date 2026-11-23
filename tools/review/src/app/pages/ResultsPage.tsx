import { Alert, AlertDescription } from '@conservationtv/ui/components/alert';
import { Spinner } from '@conservationtv/ui/components/spinner';
import { reports } from '@conservationtv/runner/reports';
import { signoffs } from '@conservationtv/runner/signoffs';
import type { RunResult } from '@conservationtv/runner/results';
import { useQuery } from '@tanstack/react-query';
import type { FC } from 'react';
import { logQuery, resultsQuery } from '../api.ts';
import { CheckMark, RelativeTime } from '../components/common.tsx';
import { Link } from '../components/Link.tsx';
import { cn } from '@conservationtv/ui/lib/utils';

// /results/<commit> and /results/<commit>/<signoff>: the signoff runs uploaded from developers' machines for a commit,
// and one run's log. A signoff's commit status links here.

interface ResultsPageProps {
  sha: string;
  signoff: string | undefined;
}

function seconds(run: RunResult): string {
  return `${Math.round(run.durationMs / 1000)}s`;
}

/** The commit's runs as they load, failing to, or loaded: each signoff's, then the chosen one's log, else the first. */
export const ResultsPage: FC<ResultsPageProps> = ({ sha, signoff }) => {
  const { data: runs, error, isPending } = useQuery(resultsQuery(sha));
  const selected = runs?.find(run => run.signoff === signoff) ?? runs?.[0];
  return (
    <main className="page narrow flex flex-col gap-4">
      <header className="list-header">
        <h1>
          Signoffs <span className="muted">at {sha.slice(0, 7)}</span>
        </h1>
        <Link to="/" className="muted">
          Pull requests
        </Link>
      </header>
      {isPending ? (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Spinner /> Reading the runs…
        </p>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}
      {runs ? <RunTabs sha={sha} runs={runs} selected={selected} /> : null}
      {selected ? <RunLog run={selected} /> : null}
    </main>
  );
};

interface RunTabsProps {
  sha: string;
  runs: readonly RunResult[];
  selected: RunResult | undefined;
}

/** Everything run at the commit, reports then signoffs, with how it went and how long it took. */
const runnable = [...reports, ...signoffs];

/** Each run at the commit, in the runner's order, with how it went and how long it took. */
const RunTabs: FC<RunTabsProps> = ({ sha, runs, selected }) => {
  if (!runs.length) return <p className="text-muted-foreground">Nothing has been run at this commit.</p>;
  return (
    <nav className="flex flex-wrap gap-1.5" aria-label="Signoffs">
      {runnable.map(each => {
        const run = runs.find(candidate => candidate.signoff === each.name);
        if (!run) return null;
        return (
          <Link
            key={each.name}
            to={`/results/${sha}/${each.name}`}
            className={cn(
              'flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-[13px] text-foreground hover:no-underline',
              run === selected && 'border-foreground'
            )}
          >
            <CheckMark state={run.state} />
            {each.label}
            <span className="text-muted-foreground">{seconds(run)}</span>
          </Link>
        );
      })}
    </nav>
  );
};

interface RunLogProps {
  run: RunResult;
}

/** One run: who ran it and when, why it failed, and everything it printed. */
const RunLog: FC<RunLogProps> = ({ run }) => {
  const label = runnable.find(each => each.name === run.signoff)?.label ?? run.signoff;
  const { data: log, error } = useQuery(logQuery(run.sha, run.signoff));
  return (
    <section className="flex flex-col gap-2">
      <p className="text-[13px] text-muted-foreground">
        {label}, run by <strong className="text-foreground">{run.ranBy}</strong> <RelativeTime iso={run.startedAt} /> in{' '}
        {seconds(run)}.
      </p>
      {run.reason ? (
        <Alert variant="destructive">
          <AlertDescription>{run.reason}</AlertDescription>
        </Alert>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error.message}</p> : null}
      {log === undefined ? null : (
        <pre className="max-h-[70vh] overflow-auto rounded-lg border border-border bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {log}
        </pre>
      )}
    </section>
  );
};
