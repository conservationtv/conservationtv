import { createStore } from '@conservationtv/store';
import { z } from 'zod';

/** The statuses this tool answers with for GitHub's failures, and for asking it to act without signing in. */
export type FailureStatus = 400 | 401 | 403 | 404 | 405 | 409 | 422 | 502 | 503;

/** A failed GitHub request, with the status the API answers with: 404 for a missing pull request, 503 when limited. */
export class GitHubError extends Error {
  constructor(
    readonly status: FailureStatus,
    message: string
  ) {
    super(message);
  }
}

export type GraphQLVariables = Record<string, string | number | null>;

export interface GitHub {
  repository: string;
  /** GitHub's REST API under the repository, such as `pulls/12`, parsed with `schema`. */
  api<T extends z.ZodType>(path: string, schema: T, freshness: Freshness): Promise<z.output<T>>;
  /**
   * GitHub's GraphQL API, for what REST doesn't say (such as whether a thread is resolved), its `data` parsed with
   * `schema`. Null without a token: GraphQL answers no one anonymously.
   */
  graphql<T extends z.ZodType>(
    query: string,
    variables: GraphQLVariables,
    schema: T,
    freshness: Freshness
  ): Promise<z.output<T> | null>;
  /** A file as committed: immutable, so cached for good. */
  raw(sha: string, path: string): Promise<string>;
  /** A GraphQL mutation, such as resolving a thread: never cached. */
  mutate(query: string, variables: GraphQLVariables): Promise<void>;
  /** A change under the repository, such as posting `issues/12/comments`: never cached. */
  send(method: 'POST' | 'PUT', path: string, json: string): Promise<void>;
}

/**
 * How long a cached response is served without asking GitHub again. After that it is revalidated with its ETag, and a
 * 304 does not count against the rate limit, so short windows are cheap.
 */
export type Freshness = 'live' | 'recent' | 'immutable';
const freshnessSeconds = { live: 15, recent: 60, immutable: 365 * 24 * 60 * 60 } satisfies Record<Freshness, number>;

const [withGitHub, useGitHub] = createStore<GitHub>('github');
export { useGitHub, withGitHub };

const FETCHED_AT = 'x-review-fetched-at';

export interface GitHubOptions {
  repository: string;
  token: string;
  /** Revalidate live responses however recently they were fetched: asked for straight after a change. */
  fresh?: boolean;
  waitUntil(promise: Promise<void>): void;
}

export function createGitHub(options: GitHubOptions): GitHub {
  const headers = new Headers({ 'user-agent': 'review.tools.conservation.tv', 'x-github-api-version': '2022-11-28' });
  if (options.token) headers.set('authorization', `Bearer ${options.token}`);
  // Anonymously, a revalidation's 304 still counts against the 60 requests an hour, so cached copies serve for longer.
  const patience = options.token ? 1 : 10;

  /** How long a cached copy serves as is, in milliseconds: not at all for a live one asked for fresh. */
  function servedFor(freshness: Freshness): number {
    return options.fresh && freshness === 'live' ? 0 : freshnessSeconds[freshness] * patience * 1000;
  }

  /** A fresh cached copy as is; a stale one revalidated with its ETag; otherwise fetched and cached. */
  async function cached(url: string, freshness: Freshness, accept: string): Promise<string> {
    const cache = caches.default;
    const key = new Request(url, { headers: { accept } });
    const hit = await cache.match(key);
    const fetchedAt = Number(hit?.headers.get(FETCHED_AT));
    if (hit && Date.now() - fetchedAt < servedFor(freshness)) return hit.text();

    const request = new Headers(headers);
    request.set('accept', accept);
    const etag = hit?.headers.get('etag');
    if (etag) request.set('if-none-match', etag);
    const response = await fetch(url, { headers: request });
    if (response.status === 304 && hit) {
      const body = await hit.text();
      store(key, body, etag);
      return body;
    }
    if (!response.ok) throw await failure(response);
    const body = await response.text();
    store(key, body, response.headers.get('etag'));
    return body;
  }

  function store(key: Request, body: string, etag: string | null | undefined) {
    const stored = new Headers({ 'cache-control': `max-age=${freshnessSeconds.immutable}` });
    stored.set(FETCHED_AT, String(Date.now()));
    if (etag) stored.set('etag', etag);
    options.waitUntil(caches.default.put(key, new Response(body, { headers: stored })));
  }

  /** A GraphQL request answered: its errors, if any, as a failure with `status`, else its data. */
  async function postGraphQL(body: string, status: FailureStatus): Promise<GraphQLResponse> {
    const request = new Headers(headers);
    request.set('content-type', 'application/json');
    const response = await fetch('https://api.github.com/graphql', { method: 'POST', headers: request, body });
    if (!response.ok) throw await failure(response);
    const parsed = GraphQLResponseSchema.parse(await response.json());
    const [error] = parsed.errors ?? [];
    if (error) throw new GitHubError(status, error.message);
    return parsed;
  }

  /** A GraphQL query, kept in the Cache API under its digest; it has no ETag, so a stale copy is fetched again. */
  async function cachedGraphQL<T extends z.ZodType>(
    body: string,
    schema: T,
    freshness: Freshness
  ): Promise<z.output<T>> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
    const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const key = new Request(`https://api.github.com/graphql/${hex}`);
    const hit = await caches.default.match(key);
    const fetchedAt = Number(hit?.headers.get(FETCHED_AT));
    if (hit && Date.now() - fetchedAt < servedFor(freshness)) return schema.parse(JSON.parse(await hit.text()));
    const { data } = await postGraphQL(body, 502);
    const parsed = schema.parse(data);
    store(key, JSON.stringify(data), null);
    return parsed;
  }

  return {
    repository: options.repository,
    async graphql(query, variables, schema, freshness) {
      if (!options.token) return null;
      return cachedGraphQL(JSON.stringify({ query, variables }), schema, freshness);
    },
    async api(path, schema, freshness) {
      const url = `https://api.github.com/repos/${options.repository}/${path}`;
      const body = await cached(url, freshness, 'application/vnd.github+json');
      return schema.parse(JSON.parse(body));
    },
    raw(sha, path) {
      const url = `https://raw.githubusercontent.com/${options.repository}/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`;
      return cached(url, 'immutable', '*/*');
    },
    async mutate(query, variables) {
      await postGraphQL(JSON.stringify({ query, variables }), 422);
    },
    async send(method, path, json) {
      const request = new Headers(headers);
      request.set('accept', 'application/vnd.github+json');
      request.set('content-type', 'application/json');
      const url = `https://api.github.com/repos/${options.repository}/${path}`;
      const response = await fetch(url, { method, headers: request, body: json });
      if (!response.ok) throw await failure(response);
    }
  };
}

/** What GraphQL answers: data, errors, or both. */
const GraphQLResponseSchema = z.object({
  data: z.unknown(),
  errors: z.array(z.object({ message: z.string() })).optional()
});
type GraphQLResponse = z.output<typeof GraphQLResponseSchema>;

/** GitHub's own explanation of a failure: its message, and the first of the errors it lists when it lists any. */
const GitHubFailureSchema = z.object({
  message: z.string().optional(),
  // GitHub lists errors as strings or as objects with a message.
  errors: z
    .array(z.union([z.string().transform(message => ({ message })), z.object({ message: z.string().optional() })]))
    .optional()
});
type GitHubFailure = z.output<typeof GitHubFailureSchema>;

/** GitHub's message, then the first error's, joined; nothing when GitHub said neither. */
async function explanation(response: Response): Promise<string | undefined> {
  const parsed = GitHubFailureSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return undefined;
  const { message, errors }: GitHubFailure = parsed.data;
  return [message, errors?.[0]?.message].filter(Boolean).join(': ') || undefined;
}

/** GitHub's statuses this tool passes on; anything else is GitHub failing. */
const passedOn = new Map<number, FailureStatus>([
  [401, 401],
  [403, 403],
  [404, 404],
  [405, 405],
  [409, 409],
  [422, 422]
]);

/** Rate limiting first, as GitHub reports it several ways; then a missing thing; then GitHub's own reason. */
async function failure(response: Response): Promise<GitHubError> {
  const limited = response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0';
  if (limited) return new GitHubError(503, 'GitHub is rate limiting this tool; try again shortly.');
  if (response.status === 404) return new GitHubError(404, 'Not found on GitHub.');
  const message = await explanation(response);
  return new GitHubError(passedOn.get(response.status) ?? 502, message ?? `GitHub answered ${response.status}.`);
}

// GitHub's REST responses, as far as this tool reads them.

const UserSchema = z
  .object({ login: z.string(), avatar_url: z.url(), html_url: z.url() })
  .nullable()
  .transform(user => ({
    // A deleted account's activity stays, attributed to no one.
    login: user?.login ?? 'ghost',
    avatarUrl: user?.avatar_url ?? 'https://avatars.githubusercontent.com/u/10137?v=4',
    url: user?.html_url ?? 'https://github.com/ghost'
  }));
export type User = z.output<typeof UserSchema>;

const RefSchema = z.object({ ref: z.string(), sha: z.string() });
export type Ref = z.output<typeof RefSchema>;

export const PullListItemSchema = z.object({
  number: z.int(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean().optional(),
  merged_at: z.string().nullable(),
  user: UserSchema,
  updated_at: z.iso.datetime(),
  base: RefSchema,
  head: RefSchema
});
export type PullListItem = z.output<typeof PullListItemSchema>;
export const PullListItemsSchema = z.array(PullListItemSchema);
export type PullListItems = z.output<typeof PullListItemsSchema>;

export const PullDetailSchema = PullListItemSchema.extend({
  body: z.string().nullable(),
  /** The commit a merge made on the base branch; GitHub sets it for open pull requests too, as a test merge. */
  merge_commit_sha: z.string().nullable(),
  html_url: z.url(),
  created_at: z.iso.datetime(),
  mergeable: z.boolean().nullable(),
  mergeable_state: z.string(),
  commits: z.int(),
  changed_files: z.int(),
  labels: z.array(z.object({ name: z.string(), color: z.string() }))
});
export type PullDetail = z.output<typeof PullDetailSchema>;

export const PullFilesSchema = z.array(
  z.object({
    filename: z.string(),
    previous_filename: z.string().optional(),
    status: z.enum(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']),
    sha: z.string().nullable(),
    additions: z.int(),
    deletions: z.int(),
    patch: z.string().optional()
  })
);
export type PullFiles = z.output<typeof PullFilesSchema>;

export const CompareSchema = z.object({ merge_base_commit: z.object({ sha: z.string() }) });
export type Compare = z.output<typeof CompareSchema>;

export const CheckRunsSchema = z.object({
  check_runs: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      html_url: z.url().nullable(),
      output: z.object({ title: z.string().nullable() })
    })
  )
});
export type CheckRuns = z.output<typeof CheckRunsSchema>;

export const CombinedStatusSchema = z.object({
  statuses: z.array(
    z.object({
      context: z.string(),
      state: z.enum(['success', 'failure', 'error', 'pending']),
      description: z.string().nullable(),
      target_url: z.url().nullable().catch(null)
    })
  )
});
export type CombinedStatus = z.output<typeof CombinedStatusSchema>;

export const IssueCommentsSchema = z.array(
  z.object({
    id: z.int(),
    user: UserSchema,
    body: z.string().nullable(),
    created_at: z.iso.datetime(),
    html_url: z.url()
  })
);
export type IssueComments = z.output<typeof IssueCommentsSchema>;

export const ReviewsSchema = z.array(
  z.object({
    id: z.int(),
    user: UserSchema,
    body: z.string().nullable(),
    state: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING']),
    // Pending reviews are their author's alone, and have not been submitted.
    submitted_at: z.iso.datetime().optional(),
    html_url: z.url(),
    // Null when the commit has since been force-pushed away.
    commit_id: z.string().nullable()
  })
);
export type Reviews = z.output<typeof ReviewsSchema>;

export const ReviewCommentsSchema = z.array(
  z.object({
    id: z.int(),
    user: UserSchema,
    body: z.string(),
    created_at: z.iso.datetime(),
    html_url: z.url(),
    path: z.string(),
    line: z.int().nullable(),
    side: z.enum(['LEFT', 'RIGHT']).nullable(),
    in_reply_to_id: z.int().optional(),
    pull_request_review_id: z.int().nullable()
  })
);
export type ReviewComments = z.output<typeof ReviewCommentsSchema>;

/** A page of a pull request's review threads: whether each is resolved or outdated, keyed by its first comment. */
export const ReviewThreadsSchema = z.object({
  repository: z.object({
    pullRequest: z.object({
      reviewThreads: z.object({
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
        nodes: z.array(
          z.object({
            id: z.string(),
            isResolved: z.boolean(),
            isOutdated: z.boolean(),
            comments: z.object({ nodes: z.array(z.object({ databaseId: z.int().nullable() })) })
          })
        )
      })
    })
  })
});
export type ReviewThreads = z.output<typeof ReviewThreadsSchema>;

export const DeploymentsSchema = z.array(
  z.object({ id: z.int(), sha: z.string(), environment: z.string(), created_at: z.iso.datetime() })
);
export type Deployments = z.output<typeof DeploymentsSchema>;

export const DeploymentStatusesSchema = z.array(
  z.object({ state: z.string(), created_at: z.iso.datetime(), log_url: z.string().nullable().optional() })
);
export type DeploymentStatuses = z.output<typeof DeploymentStatusesSchema>;

/** How a commit relates to another: `ahead` or `identical` when it contains it. */
export const CompareStatusSchema = z.object({ status: z.string() });
export type CompareStatus = z.output<typeof CompareStatusSchema>;

export const WorkflowRunSchema = z.object({ name: z.string().nullable() });
export type WorkflowRun = z.output<typeof WorkflowRunSchema>;
