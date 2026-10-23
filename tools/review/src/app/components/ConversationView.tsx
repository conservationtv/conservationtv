import type { FC } from 'react';
import type { Check, ContractChange, ConversationEntry, Pull, Review, ReviewState } from '../../shared/review.ts';
import { GENERATED_SIGNOFF, signoffs } from '../../shared/signoffs.ts';
import { Link } from './Link.tsx';
import { chaptersOf } from '../story.ts';
import { Avatar, CheckMark, MarkdownBody, RelativeTime } from './common.tsx';
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
}

const Entry: FC<EntryProps> = ({ entry }) => (
  <article className={`entry${entry.review ? ` review-${entry.review.toLowerCase()}` : ''}`}>
    <header>
      <Avatar person={entry.author} size={24} />
      <strong>{entry.author.login}</strong>
      <span className="muted">{entry.review ? reviewVerbs[entry.review] : 'commented'}</span>
      <a href={entry.url} className="muted">
        <RelativeTime iso={entry.createdAt} />
      </a>
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

const MergeBox: FC<ChecksProps> = ({ review }) => {
  const byName = new Map(review.checks.map(check => [check.name, check]));
  const others = review.checks.filter(check => check.kind !== 'signoff');
  return (
    <section className="box">
      <h3>Merge</h3>
      <p>{mergeVerdict(review.pull)}</p>
      <h4>Signoffs</h4>
      <ul className="checks">
        {signoffs.map(signoff => {
          // A signoff not yet given shows as pending, with the script that gives it.
          const check = byName.get(signoff.context);
          return (
            <li key={signoff.context} title={signoff.meaning}>
              <CheckMark state={check?.state ?? 'pending'} />
              <span>{signoff.label}</span>
              <span className="muted">{check?.description ?? <code>{signoff.script}</code>}</span>
            </li>
          );
        })}
      </ul>
      {others.length ? (
        <>
          <h4>Checks</h4>
          <ul className="checks">
            {others.map(check => (
              <CheckRow key={`${check.kind}:${check.name}`} check={check} />
            ))}
          </ul>
        </>
      ) : null}
    </section>
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
    <section className="box">
      <h3>API contracts</h3>
      {breaking ? (
        <p className="warning">
          A changed or removed version breaks clients that already require it. Before a release, keep the old contract
          and declare a new operation version.
        </p>
      ) : null}
      {[...documents].map(([document, changes]) => (
        <div key={document} className="contract-document">
          <h4>{apiName(document)}</h4>
          <ul className="contracts">
            {changes.map(change => (
              <li key={change.operation}>
                <span className={`contract-kind contract-${change.kind}`}>{contractKinds[change.kind]}</span>
                <Link to={`/pr/${number}/files/api/${encodeURIComponent(change.operation)}`}>
                  <code>{change.operation}</code>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
};

/** The review, chapter by chapter: what each holds, and a way in. */
const ReviewPathBox: FC<ChecksProps> = ({ review }) => {
  const generated = review.checks.find(check => check.name === GENERATED_SIGNOFF);
  return (
    <section className="box">
      <h3>Review path</h3>
      <ol className="review-path">
        {chaptersOf(review).map(chapter => (
          <li key={chapter.id}>
            <Link to={`/pr/${review.pull.number}/files/${chapter.id}`}>{chapter.title}</Link>
            <span className="muted">
              {chapter.id === 'api'
                ? `${review.contracts.length} operation${review.contracts.length === 1 ? '' : 's'}`
                : `${chapter.files.length} file${chapter.files.length === 1 ? '' : 's'}`}
            </span>
            <span className="additions">
              +{formatCount(chapter.files.reduce((sum, file) => sum + file.additions, 0))}
            </span>
            <span className="deletions">
              −{formatCount(chapter.files.reduce((sum, file) => sum + file.deletions, 0))}
            </span>
          </li>
        ))}
      </ol>
      {review.files.some(file => file.category === 'generated') ? (
        <p className="muted small">
          <CheckMark state={generated?.state ?? 'pending'} />{' '}
          {generated?.state === 'success'
            ? 'Generated files were regenerated at this commit and found current (signoff/generated).'
            : 'Generated files have not been signed off as current at this commit.'}
        </p>
      ) : null}
    </section>
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
        {review.conversation.map(entry => (
          <Entry key={entry.id} entry={entry} />
        ))}
        {review.threads.length ? (
          <p className="muted">
            <Link to={`/pr/${pull.number}/files`}>
              {review.threads.length} line comment thread{review.threads.length === 1 ? '' : 's'}
            </Link>{' '}
            on the changed files.
          </p>
        ) : null}
      </div>
      <aside className="sidebar">
        <MergeBox review={review} />
        <ContractsBox number={pull.number} contracts={review.contracts} />
        <ReviewPathBox review={review} />
        {pull.labels.length ? (
          <section className="box">
            <h3>Labels</h3>
            <div className="labels">
              {pull.labels.map(label => (
                <span key={label.name} className="label" style={{ borderColor: `#${label.color}` }}>
                  {label.name}
                </span>
              ))}
            </div>
          </section>
        ) : null}
      </aside>
    </main>
  );
};
