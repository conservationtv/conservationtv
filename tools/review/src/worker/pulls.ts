import type { z } from 'zod';
import { classify } from '../shared/classify.ts';
import type {
  Check,
  CheckState,
  ConversationEntry,
  PullList,
  PullState,
  PullSummary,
  Review,
  ReviewFile,
  Thread
} from '../shared/review.ts';
import { contractChanges } from './contracts.ts';
import {
  CheckRunsSchema,
  CombinedStatusSchema,
  CompareSchema,
  IssueCommentsSchema,
  PullDetailSchema,
  PullFilesSchema,
  PullListItemsSchema,
  ReviewCommentsSchema,
  ReviewsSchema,
  useGitHub,
  type Freshness,
  type PullListItem,
  type Reviews
} from './github.ts';
import { openStacks, stackOf } from './stack.ts';

const PAGE = 100;
/** GitHub lists at most 3,000 files for a pull request. */
const MAX_FILE_PAGES = 30;
const MAX_COMMENT_PAGES = 10;

/** Every page of a listing, in order: each page is fetched once the one before it comes back full. */
async function allPages<T extends z.ZodType>(
  path: string,
  schema: z.ZodArray<T>,
  freshness: Freshness
): Promise<z.output<T>[]> {
  const github = useGitHub();
  const items: z.output<T>[] = [];
  const separator = path.includes('?') ? '&' : '?';
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const batch = await github.api(`${path}${separator}per_page=${PAGE}&page=${page}`, schema, freshness);
    items.push(...batch);
    if (batch.length < PAGE) break;
  }
  return items;
}

function pullState(pull: PullListItem): PullState {
  if (pull.merged_at) return 'merged';
  if (pull.state === 'closed') return 'closed';
  return pull.draft ? 'draft' : 'open';
}

function summary(pull: PullListItem): PullSummary {
  return {
    number: pull.number,
    title: pull.title,
    state: pullState(pull),
    author: pull.user,
    baseRef: pull.base.ref,
    headRef: pull.head.ref,
    updatedAt: pull.updated_at
  };
}

/** The latest hundred pull requests, enough to find every open stack. */
async function recentPulls(): Promise<PullSummary[]> {
  const github = useGitHub();
  const pulls = await github.api(
    'pulls?state=all&sort=updated&direction=desc&per_page=100',
    PullListItemsSchema,
    'recent'
  );
  return pulls.map(summary);
}

export async function pullList(): Promise<PullList> {
  const github = useGitHub();
  const pulls = await recentPulls();
  return {
    repository: github.repository,
    open: openStacks(pulls),
    recent: pulls.filter(pull => pull.state === 'merged' || pull.state === 'closed').slice(0, 20)
  };
}

async function files(number: number, changedFiles: number): Promise<ReviewFile[]> {
  const github = useGitHub();
  const pages = Math.min(MAX_FILE_PAGES, Math.max(1, Math.ceil(changedFiles / PAGE)));
  const batches = await Promise.all(
    Array.from({ length: pages }, (_, index) =>
      github.api(`pulls/${number}/files?per_page=${PAGE}&page=${index + 1}`, PullFilesSchema, 'live')
    )
  );
  return batches.flat().map(file => {
    const patch = file.patch ?? null;
    return {
      path: file.filename,
      previousPath: file.previous_filename ?? null,
      status: file.status,
      blob: file.sha ?? '',
      additions: file.additions,
      deletions: file.deletions,
      patch,
      ...classify(file.filename, patch)
    };
  });
}

/** Actions conclusions, as this tool's check states; GitHub may add more, which read as neutral. */
const runStates = new Map<string | null, CheckState>([
  ['success', 'success'],
  ['failure', 'failure'],
  ['timed_out', 'failure'],
  ['cancelled', 'failure'],
  ['action_required', 'failure'],
  ['startup_failure', 'failure'],
  ['neutral', 'neutral'],
  ['skipped', 'skipped'],
  ['stale', 'neutral']
]);

/** Commit statuses (including `gh signoff`'s, under `signoff/`) and Actions check runs on the head commit. */
async function checks(sha: string): Promise<Check[]> {
  const github = useGitHub();
  const [status, runs] = await Promise.all([
    github.api(`commits/${sha}/status`, CombinedStatusSchema, 'live'),
    github.api(`commits/${sha}/check-runs?per_page=100`, CheckRunsSchema, 'live')
  ]);
  const statuses = status.statuses.map((entry): Check => ({
    name: entry.context,
    kind: entry.context.startsWith('signoff/') ? 'signoff' : 'status',
    state: entry.state === 'error' ? 'failure' : entry.state,
    description: entry.description,
    url: entry.target_url
  }));
  const actions = runs.check_runs.map((run): Check => ({
    name: run.name,
    kind: 'run',
    state: run.status === 'completed' ? (runStates.get(run.conclusion) ?? 'neutral') : 'pending',
    description: run.output.title,
    url: run.html_url
  }));
  return [...statuses, ...actions];
}

/**
 * A submitted review, unless it only carries line comments: then it says nothing here, and its comments are shown on
 * their lines.
 */
function reviewEntry(review: Reviews[number]): ConversationEntry[] {
  if (!review.submitted_at) return [];
  if (!review.body && review.state === 'COMMENTED') return [];
  return [
    {
      id: review.id,
      author: review.user,
      body: review.body ?? '',
      createdAt: review.submitted_at,
      url: review.html_url,
      review: review.state
    }
  ];
}

/** The pull request's comments and submitted reviews with something to say, oldest first. */
async function conversation(number: number): Promise<ConversationEntry[]> {
  const [comments, reviews] = await Promise.all([
    allPages(`issues/${number}/comments`, IssueCommentsSchema, 'live'),
    allPages(`pulls/${number}/reviews`, ReviewsSchema, 'live')
  ]);
  const entries: ConversationEntry[] = [
    ...comments.map(comment => ({
      id: comment.id,
      author: comment.user,
      body: comment.body ?? '',
      createdAt: comment.created_at,
      url: comment.html_url,
      review: null
    })),
    ...reviews.flatMap(reviewEntry)
  ];
  return entries.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Line comments, gathered into the threads their replies form. */
async function threads(number: number): Promise<Thread[]> {
  const comments = await allPages(`pulls/${number}/comments`, ReviewCommentsSchema, 'live');
  const byRoot = new Map<number, Thread>();
  for (const comment of comments.toSorted((a, b) => a.created_at.localeCompare(b.created_at))) {
    const entry = {
      id: comment.id,
      author: comment.user,
      body: comment.body,
      createdAt: comment.created_at,
      url: comment.html_url
    };
    const root = byRoot.get(comment.in_reply_to_id ?? comment.id);
    if (root) {
      root.comments.push(entry);
      continue;
    }
    byRoot.set(comment.id, {
      path: comment.path,
      line: comment.line,
      side: comment.side === 'LEFT' ? 'deletions' : 'additions',
      comments: [entry]
    });
  }
  return [...byRoot.values()];
}

export async function review(number: number): Promise<Review> {
  const github = useGitHub();
  const pull = await github.api(`pulls/${number}`, PullDetailSchema, 'live');
  const [compare, changed, checkList, entries, threadList, pulls] = await Promise.all([
    github.api(`compare/${pull.base.sha}...${pull.head.sha}`, CompareSchema, 'immutable'),
    files(number, pull.changed_files),
    checks(pull.head.sha),
    conversation(number),
    threads(number),
    recentPulls()
  ]);
  const mergeBaseSha = compare.merge_base_commit.sha;
  const current = summary(pull);
  return {
    repository: github.repository,
    pull: {
      ...current,
      body: pull.body ?? '',
      url: pull.html_url,
      createdAt: pull.created_at,
      baseSha: pull.base.sha,
      headSha: pull.head.sha,
      mergeBaseSha,
      mergeable: pull.mergeable,
      mergeableState: pull.mergeable_state,
      commits: pull.commits,
      labels: pull.labels
    },
    files: changed,
    checks: checkList,
    conversation: entries,
    threads: threadList,
    // The listing can lag this pull request's own state; this one is current.
    stack: stackOf(current, [current, ...pulls.filter(other => other.number !== number)]),
    contracts: await contractChanges(changed, mergeBaseSha, pull.head.sha)
  };
}
