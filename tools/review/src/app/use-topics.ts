import { useQuery } from '@tanstack/react-query';
import type { Review } from '../shared/review.ts';
import { callsQuery } from './api.ts';
import { topicsOf, type Topic } from './topics.ts';

/** The pull request's topics, once its calls report is known to be there or not; null until then. */
export function useTopics(review: Review): Topic[] | null {
  const calls = useQuery(callsQuery(review.pull.headSha));
  if (calls.isPending) return null;
  return topicsOf(review, calls.data ?? null);
}
