import { GENERATED_SIGNOFF } from '@conservationtv/runner/signoffs';
import { Alert } from '@conservationtv/ui/components/alert';
import { Badge } from '@conservationtv/ui/components/badge';
import { Button } from '@conservationtv/ui/components/button';
import { cn } from '@conservationtv/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import type { FC } from 'react';
import type { ContractChange, Review } from '../../shared/review.ts';
import { pullQueries } from '../api.ts';
import { formatCount } from '../format.ts';
import { operationParts } from '../story.ts';
import { unitTitle, type Topic, type TopicNode } from '../topics.ts';
import { CallTreeView } from './CallTreeView.tsx';
import { CheckMark, ContractKindBadge, MarkdownBody } from './common.tsx';
import type { Viewer } from './DiffList.tsx';
import { Link } from './Link.tsx';
import { OperationDocsView } from './OperationDocs.tsx';
import { ThreadView } from './ThreadView.tsx';

// The top of a topic: what it is, the operation it serves and what its contract change means to clients, the calls
// it is made of (each opening its diff below), where it is entered from, and what was generated from it.

function plural(count: number, noun: string): string {
  return `${formatCount(count)} ${noun}${count === 1 ? '' : 's'}`;
}

const kindLabels = {
  added: 'New operation',
  changed: 'Changed contract',
  removed: 'Removed'
} satisfies Record<ContractChange['kind'], string>;

/** `apps/studio/api/contracts/openapi.json` names the studio API. */
function apiName(document: string): string {
  const [, app, api] = document.match(/^apps\/([^/]+)\/([^/]+)\//) ?? [];
  return app ? `${app} ${api}` : document;
}

/** What a kind of contract change means to the clients that use it. */
function consequence(change: ContractChange): string {
  const [id, version] = operationParts(change.operation);
  if (change.kind === 'added') {
    return `A new operation version: clients that ask for ${id} v${version} get this contract. It is frozen once released, so later changes need v${version + 1}.`;
  }
  if (change.kind === 'removed') {
    return `Clients that require ${id} v${version} will no longer be served. Check nothing released still asks for it.`;
  }
  return `${id} v${version} existed before this pull request, and its contract differs. Fine before it is released; after that, keep v${version} as it was and declare v${version + 1}.`;
}

interface OperationBlockProps {
  review: Review;
  change: ContractChange;
}

/** The operation a topic serves: where it is served, what its change means, and its documentation before and after. */
const OperationBlock: FC<OperationBlockProps> = ({ review, change }) => {
  const docs = useQuery(pullQueries.operation(review.pull.number, change.document, change.operation));
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <p className="flex items-center gap-2 text-xs">
        <ContractKindBadge kind={change.kind}>{kindLabels[change.kind]}</ContractKindBadge>
        <span className="text-muted-foreground">{apiName(change.document)}</span>
        <code className="text-muted-foreground">{change.operation}</code>
      </p>
      {change.summary ? <p className="font-medium">{change.summary}</p> : null}
      <p className={cn('text-[13px]', change.kind !== 'added' && 'text-(--warning)')}>{consequence(change)}</p>
      {change.description ? <MarkdownBody text={change.description} /> : null}
      {docs.error ? <p className="text-xs text-destructive">{docs.error.message}</p> : null}
      {docs.data ? <OperationDocsView docs={docs.data} kind={change.kind} /> : null}
    </section>
  );
};

interface CallOutlineProps {
  review: Review;
  nodes: readonly TopicNode[];
  viewer: Viewer;
}

interface OutlineRowProps {
  review: Review;
  node: TopicNode;
  viewer: Viewer;
}

/** A changed unit, as deep as the calls to it go: opening its diff below, or the topic that reads it. */
const OutlineRow: FC<OutlineRowProps> = ({ review, node: { unit, depth, elsewhere }, viewer }) => (
  <li className="flex items-center gap-1.5" style={{ paddingLeft: `${depth * 1.25}rem` }}>
    {depth ? (
      <span className="text-muted-foreground" aria-hidden>
        ↳
      </span>
    ) : null}
    <span
      className={cn('size-2 shrink-0 rounded-full', unit.status === 'added' ? 'bg-(--success)' : 'bg-(--warning)')}
      title={unit.status === 'added' ? 'New' : 'Changed'}
    />
    {elsewhere ? (
      <Link to={`/pr/${review.pull.number}/files/${elsewhere}`} className="font-mono">
        {unitTitle(unit.name)}
      </Link>
    ) : (
      <Button
        variant="link"
        size="sm"
        className="h-auto p-0 font-mono text-[13px] text-foreground"
        onClick={() => viewer.current?.scrollTo({ type: 'item', id: unit.path, align: 'start' })}
      >
        {unitTitle(unit.name)}
      </Button>
    )}
    <span className="truncate text-xs text-muted-foreground">
      {elsewhere ? 'read in its own topic' : `${unit.path.split('/').at(-1)}:${unit.line}`}
    </span>
  </li>
);

/** The topic's changed units as the calls between them: each opens its file's diff below, or the topic that has it. */
const CallOutline: FC<CallOutlineProps> = ({ review, nodes, viewer }) => (
  <ol className="flex flex-col gap-0.5 text-[13px]">
    {nodes.map(node => (
      <OutlineRow key={`${node.unit.id}:${node.depth}`} review={review} node={node} viewer={viewer} />
    ))}
  </ol>
);

interface TopicIntroProps {
  review: Review;
  topic: Topic;
  viewer: Viewer;
}

/** Whether what a topic generated was regenerated and found current at the head. */
const GeneratedNote: FC<TopicIntroProps> = ({ review, topic }) => {
  if (!topic.files.some(part => part.file.category === 'generated')) return null;
  const signoff = review.checks.find(check => check.name === GENERATED_SIGNOFF);
  const signed = signoff?.state === 'success';
  return (
    <Alert className={cn('flex gap-1.5 bg-muted text-[13px]', signed && 'border-(--success)/40')}>
      <CheckMark state={signoff?.state ?? 'pending'} />
      <span>
        {signed
          ? 'Its generated files were regenerated at this commit and nothing changed (signoff/generated): they are folded below.'
          : 'Its generated files are not signed off as current at this commit: run pnpm signoff generated.'}
      </span>
    </Alert>
  );
};

/** Each part of a topic's introduction, when it has one: operations, calls, callers, threads, generated output. */
export const TopicIntro: FC<TopicIntroProps> = ({ review, topic, viewer }) => {
  const outdated = topic.threads.filter(thread => thread.line === null);
  return (
    <header className="intro flex flex-col gap-3">
      <div>
        <h2>
          {topic.title}{' '}
          <span className="muted">
            +{formatCount(topic.additions)} −{formatCount(topic.deletions)}
          </span>
        </h2>
        {topic.subtitle ? <p className="font-mono text-xs text-muted-foreground">{topic.subtitle}</p> : null}
      </div>
      {topic.operations.map(change => (
        <OperationBlock key={change.operation} review={review} change={change} />
      ))}
      {topic.trees.map(tree => (
        <CallTreeView key={tree.key} review={review} tree={tree} />
      ))}
      {!topic.trees.length && topic.nodes.length ? (
        <CallOutline review={review} nodes={topic.nodes} viewer={viewer} />
      ) : null}
      {topic.enteredFrom.length ? (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          Entered from
          {topic.enteredFrom.map(caller => (
            <Badge key={caller.id} variant="outline" className="font-mono" title={`${caller.path}:${caller.line}`}>
              {unitTitle(caller.name)}
            </Badge>
          ))}
        </p>
      ) : null}
      {topic.threads.length ? (
        <p className="text-xs text-muted-foreground">
          {plural(topic.threads.length, 'thread')} on this topic, on their lines below.
        </p>
      ) : null}
      <GeneratedNote review={review} topic={topic} viewer={viewer} />
      {outdated.map(thread => (
        <ThreadView key={thread.comments[0]?.id} number={review.pull.number} thread={thread} />
      ))}
    </header>
  );
};
