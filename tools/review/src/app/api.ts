import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  SessionSchema,
  type CommentRequest,
  type LineCommentRequest,
  type MergeRequest,
  type ReviewRequest
} from '../shared/actions.ts';
import { OperationDocsSchema } from '../shared/operation.ts';
import { ApiErrorSchema, PullListSchema, ReviewSchema } from '../shared/review.ts';

/** The API's own explanation of a failure, else its status. */
async function failure(response: Response): Promise<Error> {
  const body = await response.json().catch(() => null);
  return new Error(ApiErrorSchema.safeParse(body).data?.error ?? `The API answered ${response.status}.`);
}

async function load<T extends z.ZodType>(path: string, schema: T, headers?: HeadersInit): Promise<z.output<T>> {
  const response = await fetch(path, { headers });
  if (!response.ok) throw await failure(response);
  return schema.parse(await response.json());
}

/** Who is signed in, if anyone, and whether signing in is set up at all. */
export const sessionQuery = queryOptions({
  queryKey: ['session'] as const,
  queryFn: () => load('/api/auth/session', SessionSchema),
  staleTime: Infinity
});

/** What a change sends: nothing, for signing out. */
type ActionBody = MergeRequest | CommentRequest | LineCommentRequest | ReviewRequest;

/** A change made on GitHub as the signed-in reviewer. */
export async function send(path: string, body?: ActionBody): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) throw await failure(response);
}

/** The pull request read again straight after a change, past the Worker's few seconds of cache, so the change shows. */
export async function refreshReview(queryClient: QueryClient, number: number): Promise<void> {
  const review = await load(`/api/pulls/${number}`, ReviewSchema, { 'x-review-fresh': '1' });
  queryClient.setQueryData(pullQueries.review(number).queryKey, review);
}

export const pullQueries = {
  list: () => queryOptions({ queryKey: ['pulls'] as const, queryFn: () => load('/api/pulls', PullListSchema) }),
  review: (number: number) =>
    queryOptions({
      queryKey: ['pulls', number] as const,
      queryFn: () => load(`/api/pulls/${number}`, ReviewSchema),
      // Checks, comments and mergeability move while the page is open.
      refetchInterval: 60_000
    }),
  /** One operation as documentation, both sides of it: fetched when its page is opened. */
  operation: (number: number, document: string, operation: string) =>
    queryOptions({
      queryKey: ['pulls', number, 'operations', document, operation] as const,
      queryFn: () =>
        load(
          `/api/pulls/${number}/operations/${encodeURIComponent(operation)}?document=${encodeURIComponent(document)}`,
          OperationDocsSchema
        )
    })
};

/** A file as committed. Commits never change, so a file is fetched once. */
export async function rawFile(sha: string, path: string): Promise<string> {
  const response = await fetch(`/api/raw/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`);
  if (!response.ok) throw new Error(`Could not read ${path} at ${sha.slice(0, 7)}.`);
  return response.text();
}
