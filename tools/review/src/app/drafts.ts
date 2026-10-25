import { useState } from 'react';
import { z } from 'zod';
import { LineCommentSchema, type LineComment } from '../shared/actions.ts';
import type { Review } from '../shared/review.ts';

// Line comments written but not yet sent, kept in this browser per pull request until the review they belong to is
// submitted: a reload or a closed tab loses none of them.

export const DraftSchema = LineCommentSchema.extend({ id: z.string() });
export type Draft = z.output<typeof DraftSchema>;
const DraftListSchema = z.array(DraftSchema);
type DraftList = z.output<typeof DraftListSchema>;

function read(key: string): DraftList {
  try {
    return DraftListSchema.parse(JSON.parse(localStorage.getItem(key) ?? '[]'));
  } catch {
    return [];
  }
}

export interface Drafts {
  all: readonly Draft[];
  add(comment: LineComment): void;
  remove(id: string): void;
  clear(): void;
}

export function useDrafts(review: Review): Drafts {
  const key = `review:drafts:${review.repository}#${review.pull.number}`;
  const [all, setAll] = useState(() => read(key));
  const save = (next: DraftList) => {
    localStorage.setItem(key, JSON.stringify(next));
    setAll(next);
  };
  return {
    all,
    add: comment => save([...all, { ...comment, id: crypto.randomUUID() }]),
    remove: id => save(all.filter(draft => draft.id !== id)),
    clear: () => save([])
  };
}
