import type { z } from 'zod';
import { classify, headerLine } from '@conservationtv/runner/classify';
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
  ReviewThreadsSchema,
  useGitHub,
  type Freshness,
  type GraphQLVariables,
  type PullListItem,
  type Reviews,
  type ReviewThreads
} from './github.ts';
import { openStacks, stackOf } from './stack.ts';

const PAGE = 100;
/** GitHub lists at most 3,000 files for a pull request. */
const MAX_FILE_PAGES = 30;
const MAX_COMMENT_PAGES = 10;

/** Every page of a listing, in order: each page is fetched once the one before it comes back full. */
export async function allPages<T extends z.ZodType>(
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
      ...classify(file.filename, headerLine(patch))
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
      review: review.state,
      commitId: review.commit_id
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
      review: null,
      commitId: null
    })),
    ...reviews.flatMap(reviewEntry)
  ];
  return entries.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const REVIEW_THREADS = `
  query ($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { id isResolved isOutdated comments(first: 1) { nodes { databaseId } } }
        }
      }
    }
  }
`;

/** What GraphQL knows of a thread that REST doesn't, by the id of its first comment. */
interface ThreadState {
  id: string;
  resolved: boolean;
}

/** Each thread's GraphQL id and whether it is resolved; empty without a token, which GraphQL needs. */
async function threadStates(number: number): Promise<Map<number, ThreadState>> {
  const github = useGitHub();
  const [owner = '', name = ''] = github.repository.split('/');
  const states = new Map<number, ThreadState>();
  let after: string | null = null;
  for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
    // A page at a time, up to the same cap as REST listings: each thread keyed by its first comment's id, which is how
    // REST's line comments name it. No token answers nothing, and the threads then read without their state.
    const variables: GraphQLVariables = { owner, name, number, after };
    const result: ReviewThreads | null = await github.graphql(REVIEW_THREADS, variables, ReviewThreadsSchema, 'live');
    if (!result) break;
    const { nodes, pageInfo } = result.repository.pullRequest.reviewThreads;
    for (const node of nodes) {
      const first = node.comments.nodes[0]?.databaseId;
      if (first != null) states.set(first, { id: node.id, resolved: node.isResolved });
    }
    if (!pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
  }
  return states;
}

/** Line comments, gathered into the threads their replies form, each with whether it is resolved. */
async function threads(number: number): Promise<Thread[]> {
  const [comments, states] = await Promise.all([
    allPages(`pulls/${number}/comments`, ReviewCommentsSchema, 'live'),
    // A thread still reads without its state: GraphQL is only what REST leaves out.
    threadStates(number).catch((error: Error) => {
      console.error(error);
      return new Map<number, ThreadState>();
    })
  ]);
  const byRoot = new Map<number, Thread>();
  for (const comment of comments.toSorted((a, b) => a.created_at.localeCompare(b.created_at))) {
    // Oldest first, so each reply lands in the thread its first comment started; a thread takes its place, review and
    // state from that first comment.
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
    const state = states.get(comment.id);
    byRoot.set(comment.id, {
      id: state?.id ?? null,
      reviewId: comment.pull_request_review_id,
      resolved: state ? state.resolved : null,
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
  const [compare, changed, checkList, talk, threadList, pulls] = await Promise.all([
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
    conversation: talk,
    threads: threadList,
    // The listing can lag this pull request's own state; this one is current.
    stack: stackOf(current, [current, ...pulls.filter(other => other.number !== number)]),
    contracts: await contractChanges(changed, mergeBaseSha, pull.head.sha)
  };
}
