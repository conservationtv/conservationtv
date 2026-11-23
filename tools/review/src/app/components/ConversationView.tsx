import { Badge } from '@conservationtv/ui/components/badge';
import { Button } from '@conservationtv/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@conservationtv/ui/components/card';
import { NativeSelect, NativeSelectOption } from '@conservationtv/ui/components/native-select';
import { cn } from '@conservationtv/ui/lib/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FC, type ReactNode } from 'react';
import { MergeMethodSchema, type MergeMethod } from '../../shared/actions.ts';
import type {
  Check,
  CheckState,
  ContractChange,
  ConversationEntry,
  Pull,
  Review,
  ReviewState
} from '../../shared/review.ts';
import type { RunResult } from '@conservationtv/runner/results';
import { GENERATED_SIGNOFF, signoffContext, signoffs, type Signoff } from '@conservationtv/runner/signoffs';
import { refreshReview, resultsQuery, send } from '../api.ts';
import { signInHref, useSession } from '../session.ts';
import { botReports, isReviewBot } from '../../shared/bots.ts';
import { CommentAgent, SignoffAgent } from './AgentButton.tsx';
import { BotCard, BotEntry } from './BotReviews.tsx';
import { DeploysCard } from './DeploysCard.tsx';
import { Composer } from './Composer.tsx';
import { Link } from './Link.tsx';
import { useTopics } from '../use-topics.ts';
import { Avatar, CheckMark, ContractKindBadge, MarkdownBody, RelativeTime } from './common.tsx';
import { formatCount } from '../format.ts';

const reviewVerbs = {
  APPROVED: 'approved these changes',
  CHANGES_REQUESTED: 'requested changes',
  COMMENTED: 'reviewed',
  DISMISSED: 'had a review dismissed',
  PENDING: 'started a review'
} satisfies Record<ReviewState, string>;

interface EntryProps {
  entry: ConversationEntry;
  number: number;
  /** The pull request is open, so an agent can still act on a comment. */
  open: boolean;
}

/** A review's verdict, at a glance, on its border. */
const reviewBorders = {
  APPROVED: 'border-(--success)/50',
  CHANGES_REQUESTED: 'border-destructive/50',
  COMMENTED: null,
  DISMISSED: null,
  PENDING: null
} satisfies Record<ReviewState, string | null>;

/** A comment or review: who, what they did, when; on a plain comment of an open pull request, an agent to act on it. */
const Entry: FC<EntryProps> = ({ entry, number, open }) => (
  <article className={cn('entry', entry.review ? reviewBorders[entry.review] : null)}>
    <header>
      <Avatar person={entry.author} size={24} />
      <strong>{entry.author.login}</strong>
      <span className="muted">{entry.review ? reviewVerbs[entry.review] : 'commented'}</span>
      <a href={entry.url} className="muted">
        <RelativeTime iso={entry.createdAt} />
      </a>
      {open && entry.review === null ? (
        <span className="ml-auto">
          <CommentAgent number={number} comment={entry.id} kind="conversation" />
        </span>
      ) : null}
    </header>
    {entry.body ? <MarkdownBody text={entry.body} /> : null}
  </article>
);

/** GitHub's `mergeable_state`s, as said to a reviewer. It may add more, which read as mergeable. */
function mergeableStateLabels(pull: Pull): Map<string, string> {
  return new Map([
    ['clean', 'Ready to merge.'],
    ['blocked', 'Mergeable, but blocked by branch protection.'],
    ['behind', `Mergeable, but behind ${pull.baseRef}.`],
    ['unstable', 'Mergeable, with checks that have not passed.'],
    ['draft', 'A draft: ready to merge once it is marked ready for review.']
  ]);
}

/** Where the pull request stands with GitHub: merged or closed, still being worked out, conflicting, or its state. */
function mergeVerdict(pull: Pull): string {
  if (pull.state === 'merged') return 'Merged.';
  if (pull.state === 'closed') return 'Closed without merging.';
  if (pull.mergeable === null) return 'GitHub is still checking whether this can merge.';
  if (!pull.mergeable) return `Conflicts with ${pull.baseRef}: rebase or merge it in before this can merge.`;
  const mergeableStates = mergeableStateLabels(pull);
  return mergeableStates.get(pull.mergeableState) ?? 'Mergeable.';
}

interface ChecksProps {
  review: Review;
}

const mergeMethods = {
  merge: 'Create a merge commit',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge'
} satisfies Record<MergeMethod, string>;

/**
 * Merging as the signed-in reviewer, asked twice: once to choose how, once to confirm. GitHub has the last word, and
 * refuses if the branch moved since this page read it.
 */
const MergeControls: FC<ChecksProps> = ({ review }) => {
  const session = useSession();
  const queryClient = useQueryClient();
  const [method, setMethod] = useState<MergeMethod>('merge');
  const [confirming, setConfirming] = useState(false);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { pull } = review;
  if (pull.state !== 'open' || !session?.viewer) return null;

  async function merge() {
    setMerging(true);
    setError(null);
    try {
      await send(`/api/pulls/${pull.number}/merge`, { method, sha: pull.headSha });
      await refreshReview(queryClient, pull.number);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The merge did not go through.');
    } finally {
      setMerging(false);
      setConfirming(false);
    }
  }

  return (
    <div className="mt-1 mb-3 flex flex-col gap-2">
      <NativeSelect
        value={method}
        aria-label="How to merge"
        className="w-full"
        disabled={merging}
        onChange={event => setMethod(MergeMethodSchema.parse(event.target.value))}
      >
        {Object.entries(mergeMethods).map(([value, label]) => (
          <NativeSelectOption key={value} value={value}>
            {label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {confirming ? (
        <div className="flex flex-wrap gap-1.5">
          <Button loading={merging} onClick={() => void merge()}>
            Confirm: merge into {pull.baseRef}
          </Button>
          <Button variant="outline" disabled={merging} onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button disabled={pull.mergeable === false} onClick={() => setConfirming(true)}>
          Merge pull request
        </Button>
      )}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
};

/** A comment on the pull request as the signed-in reviewer, or a way to sign in to write one. */
const CommentForm: FC<ChecksProps> = ({ review }) => {
  const session = useSession();
  const queryClient = useQueryClient();
  const number = review.pull.number;
  if (!session?.enabled) return null;
  if (!session.viewer) {
    return (
      <p className="text-muted-foreground">
        <a href={signInHref()}>Sign in with GitHub</a> to comment, review and merge.
      </p>
    );
  }
  return (
    <section className="entry p-3">
      <Composer
        placeholder="Leave a comment (Markdown)"
        actions={[
          {
            label: 'Comment',
            primary: true,
            run: async body => {
              await send(`/api/pulls/${number}/comments`, { body });
              await refreshReview(queryClient, number);
            }
          }
        ]}
      />
    </section>
  );
};

interface SidebarCardProps {
  title: string;
  children: ReactNode;
}

/** One of the sidebar's cards: a title, then what it holds. */
const SidebarCard: FC<SidebarCardProps> = ({ title, children }) => (
  <Card size="sm" className="gap-2 text-[13px]">
    <CardHeader>
      <CardTitle>{title}</CardTitle>
    </CardHeader>
    <CardContent className="flex flex-col gap-1">{children}</CardContent>
  </Card>
);

/** A heading within a sidebar card. */
interface CardSubheadingProps {
  children: ReactNode;
  className?: string;
}

const CardSubheading: FC<CardSubheadingProps> = ({ children, className }) => (
  <h4 className={cn('mt-2 text-xs font-semibold text-muted-foreground', className)}>{children}</h4>
);

/** A signoff's state: its commit status's, else failed when its uploaded run did, else not given yet. */
function signoffState(check: Check | undefined, run: RunResult | undefined): CheckState {
  if (check) return check.state;
  return run?.state === 'failure' ? 'failure' : 'pending';
}

interface SignoffDetailProps {
  signoff: Signoff;
  check: Check | undefined;
  run: RunResult | undefined;
}

/** Why a run failed, else what its status says, else the script that gives it. */
const SignoffDetail: FC<SignoffDetailProps> = ({ signoff, check, run }) => (
  <>{run?.reason ?? check?.description ?? <code>pnpm signoff {signoff.name}</code>}</>
);

interface SignoffRowProps {
  number: number;
  /** An agent can be started on it: the pull request is open. */
  open: boolean;
  signoff: Signoff;
  check: Check | undefined;
  run: RunResult | undefined;
}

/**
 * A signoff: given or not, as its commit status says, and its run at the head commit when one was uploaded, which
 * says why it failed. One not yet given shows the script that gives it.
 */
const SignoffRow: FC<SignoffRowProps> = ({ number, open, signoff, check, run }) => {
  const state = signoffState(check, run);
  return (
    <li title={signoff.meaning} className="grid-cols-[1rem_auto_minmax(0,1fr)_auto] items-center">
      <CheckMark state={state} />
      {run ? <Link to={`/results/${run.sha}/${run.signoff}`}>{signoff.label}</Link> : <span>{signoff.label}</span>}
      <span className="muted">
        <SignoffDetail signoff={signoff} check={check} run={run} />
      </span>
      {open && state !== 'success' ? (
        <SignoffAgent
          number={number}
          signoffs={[signoff.name]}
          label={`Sign off ${signoff.label} with an agent`}
          iconOnly
        />
      ) : null}
    </li>
  );
};

/** Merging, then each signoff with its run and, for an operator, an agent to give it; then the other checks. */
const MergeBox: FC<ChecksProps> = ({ review }) => {
  const byName = new Map(review.checks.map(check => [check.name, check]));
  const others = review.checks.filter(check => check.kind !== 'signoff');
  const { data: runs } = useQuery(resultsQuery(review.pull.headSha));
  const runOf = new Map(runs?.map(run => [run.signoff, run]));
  return (
    <SidebarCard title="Merge">
      <p>{mergeVerdict(review.pull)}</p>
      <MergeControls review={review} />
      <div className="mt-2 flex items-center justify-between gap-2">
        <CardSubheading className="mt-0">Signoffs</CardSubheading>
        {review.pull.state === 'open' || review.pull.state === 'draft' ? (
          <SignoffAgent number={review.pull.number} label="Sign off with agent" size="xs" />
        ) : null}
      </div>
      <ul className="checks">
        {signoffs.map(signoff => (
          <SignoffRow
            key={signoff.name}
            number={review.pull.number}
            open={review.pull.state === 'open' || review.pull.state === 'draft'}
            signoff={signoff}
            check={byName.get(signoffContext(signoff))}
            run={runOf.get(signoff.name)}
          />
        ))}
      </ul>
      {others.length ? (
        <>
          <CardSubheading>Checks</CardSubheading>
          <ul className="checks">
            {others.map(check => (
              <CheckRow key={`${check.kind}:${check.name}`} check={check} />
            ))}
          </ul>
        </>
      ) : null}
    </SidebarCard>
  );
};

interface CheckRowProps {
  check: Check;
}

const CheckRow: FC<CheckRowProps> = ({ check }) => (
  <li>
    <CheckMark state={check.state} />
    {check.url ? <a href={check.url}>{check.name}</a> : <span>{check.name}</span>}
    {check.description ? <span className="muted">{check.description}</span> : null}
  </li>
);

const contractKinds = {
  added: 'New version',
  changed: 'Changed',
  removed: 'Removed'
} satisfies Record<ContractChange['kind'], string>;

/** `apps/studio/api/contracts/openapi.json` names the studio API. */
function apiName(document: string): string {
  const [, app, api] = document.match(/^apps\/([^/]+)\/([^/]+)\//) ?? [];
  return app ? `${app} ${api}` : document;
}

interface ContractsBoxProps {
  number: number;
  contracts: readonly ContractChange[];
}

const ContractsBox: FC<ContractsBoxProps> = ({ number, contracts }) => {
  if (!contracts.length) return null;
  const documents = Map.groupBy(contracts, change => change.document);
  const breaking = contracts.some(change => change.kind !== 'added');
  return (
    <SidebarCard title="API contracts">
      {breaking ? (
        <p className="text-xs text-(--warning)">
          A changed or removed version breaks clients that already require it. Before a release, keep the old contract
          and declare a new operation version.
        </p>
      ) : null}
      {[...documents].map(([document, changes]) => (
        <div key={document}>
          <CardSubheading>{apiName(document)}</CardSubheading>
          <ul className="contracts">
            {changes.map(change => (
              <li key={change.operation}>
                <ContractKindBadge kind={change.kind}>{contractKinds[change.kind]}</ContractKindBadge>
                <Link to={`/pr/${number}/files/api/${encodeURIComponent(change.operation)}`}>
                  <code>{change.operation}</code>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </SidebarCard>
  );
};

/** The review topic by topic: what each is, how much it changes and its open threads, and a way in. */
const TopicsBox: FC<ChecksProps> = ({ review }) => {
  const topics = useTopics(review);
  const generated = review.checks.find(check => check.name === GENERATED_SIGNOFF);
  return (
    <SidebarCard title="Topics">
      {topics ? (
        <ol className="review-path">
          {topics.map(topic => {
            const open = topic.threads.filter(thread => thread.resolved !== true).length;
            return (
              <li key={topic.id}>
                <Link to={`/pr/${review.pull.number}/files/${topic.id}`} className="truncate">
                  {topic.title}
                </Link>
                <span className="muted">{open ? `${open} open` : ''}</span>
                <span className="additions">+{formatCount(topic.additions)}</span>
                <span className="deletions">−{formatCount(topic.deletions)}</span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-muted-foreground">Reading the calls report…</p>
      )}
      {review.files.some(file => file.category === 'generated') ? (
        <p className="mt-1 flex gap-1.5 text-xs text-muted-foreground">
          <CheckMark state={generated?.state ?? 'pending'} />
          {generated?.state === 'success'
            ? 'Generated files were regenerated at this commit and found current (signoff/generated).'
            : 'Generated files have not been signed off as current at this commit.'}
        </p>
      ) : null}
    </SidebarCard>
  );
};

export const ConversationView: FC<ChecksProps> = ({ review }) => {
  const { pull } = review;
  return (
    <main className="conversation">
      <div className="timeline">
        <article className="entry">
          <header>
            <Avatar person={pull.author} size={24} />
            <strong>{pull.author.login}</strong>
            <span className="muted">opened this</span>
            <RelativeTime iso={pull.createdAt} />
          </header>
          <MarkdownBody text={pull.body} />
        </article>
        {review.conversation.map(entry =>
          entry.review && isReviewBot(entry.author.login) ? (
            <BotEntry key={entry.id} entry={entry} head={pull.headSha} />
          ) : (
            <Entry
              key={entry.id}
              entry={entry}
              number={pull.number}
              open={pull.state === 'open' || pull.state === 'draft'}
            />
          )
        )}
        {review.threads.length ? (
          <p className="text-muted-foreground">
            <Link to={`/pr/${pull.number}/files`}>
              {review.threads.length} line comment thread{review.threads.length === 1 ? '' : 's'}
            </Link>{' '}
            on the changed files.
          </p>
        ) : null}
        <CommentForm review={review} />
      </div>
      <aside className="sidebar">
        <MergeBox review={review} />
        <DeploysCard review={review} />
        {botReports(review.conversation, review.threads).map(report => (
          <BotCard key={report.login} review={review} report={report} />
        ))}
        <ContractsBox number={pull.number} contracts={review.contracts} />
        <TopicsBox review={review} />
        {pull.labels.length ? (
          <SidebarCard title="Labels">
            <div className="flex flex-wrap gap-1.5">
              {pull.labels.map(label => (
                <Badge key={label.name} variant="outline" style={{ borderColor: `#${label.color}` }}>
                  {label.name}
                </Badge>
              ))}
            </div>
          </SidebarCard>
        ) : null}
      </aside>
    </main>
  );
};
