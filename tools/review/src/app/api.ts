import { queryOptions } from '@tanstack/react-query';
import type { z } from 'zod';
import { ApiErrorSchema, PullListSchema, ReviewSchema } from '../shared/review.ts';

async function load<T extends z.ZodType>(path: string, schema: T): Promise<z.output<T>> {
  const response = await fetch(path);
  const body = await response.json();
  if (!response.ok)
    throw new Error(ApiErrorSchema.safeParse(body).data?.error ?? `The API answered ${response.status}.`);
  return schema.parse(body);
}

export const pullQueries = {
  list: () => queryOptions({ queryKey: ['pulls'] as const, queryFn: () => load('/api/pulls', PullListSchema) }),
  review: (number: number) =>
    queryOptions({
      queryKey: ['pulls', number] as const,
      queryFn: () => load(`/api/pulls/${number}`, ReviewSchema),
      // Checks, comments and mergeability move while the page is open.
      refetchInterval: 60_000
    })
};

/** A file as committed. Commits never change, so a file is fetched once. */
export async function rawFile(sha: string, path: string): Promise<string> {
  const response = await fetch(`/api/raw/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`);
  if (!response.ok) throw new Error(`Could not read ${path} at ${sha.slice(0, 7)}.`);
  return response.text();
}
