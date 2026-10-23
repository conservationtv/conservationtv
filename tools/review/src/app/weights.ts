import { categories } from '../shared/classify.ts';
import type { Category, ReviewFile } from '../shared/review.ts';

export interface CategoryWeight {
  category: Category;
  files: number;
  additions: number;
  deletions: number;
}

/** Each kind of file's share of the change, in reading order, leaving out kinds the pull request does not touch. */
export function weigh(files: readonly ReviewFile[]): CategoryWeight[] {
  return categories
    .map(category => {
      const members = files.filter(file => file.category === category);
      return {
        category,
        files: members.length,
        additions: members.reduce((sum, file) => sum + file.additions, 0),
        deletions: members.reduce((sum, file) => sum + file.deletions, 0)
      };
    })
    .filter(weight => weight.files > 0);
}
