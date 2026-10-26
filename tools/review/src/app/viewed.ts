import { useState } from 'react';
import { z } from 'zod';
import type { Review, ReviewFile } from '../shared/review.ts';

// Files marked viewed, kept in this browser per pull request. A file stays viewed until its blob changes, so a push
// unmarks only the files it touches.

const ViewedSchema = z.record(z.string(), z.string());
type Viewed = z.output<typeof ViewedSchema>;

function read(key: string): Viewed {
  try {
    return ViewedSchema.parse(JSON.parse(localStorage.getItem(key) ?? '{}'));
  } catch {
    return {};
  }
}

export interface ViewedFiles {
  isViewed(file: ReviewFile): boolean;
  toggle(file: ReviewFile): void;
}

export function useViewed(review: Review): ViewedFiles {
  const key = `review:viewed:${review.repository}#${review.pull.number}`;
  const [viewed, setViewed] = useState(() => read(key));
  return {
    isViewed: file => viewed[file.path] === file.blob,
    toggle: file => {
      const { [file.path]: _, ...rest } = viewed;
      const next = viewed[file.path] === file.blob ? rest : { ...rest, [file.path]: file.blob };
      localStorage.setItem(key, JSON.stringify(next));
      setViewed(next);
    }
  };
}
