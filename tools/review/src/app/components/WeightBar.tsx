import type { FC } from 'react';
import { categoryLabels } from '../../shared/classify.ts';
import type { CategoryWeight } from '../weights.ts';
import { formatCount } from '../format.ts';

interface WeightBarProps {
  weights: readonly CategoryWeight[];
}

/** How the changed lines divide between what is read and what is generated from it. */
export const WeightBar: FC<WeightBarProps> = ({ weights }) => {
  const total = weights.reduce((sum, weight) => sum + weight.additions + weight.deletions, 0) || 1;
  const read = weights
    .filter(weight => weight.category === 'source' || weight.category === 'migration')
    .reduce((sum, weight) => sum + weight.additions + weight.deletions, 0);
  return (
    <div className="weight">
      <div className="weight-bar" role="img" aria-label="Changed lines by kind of file">
        {weights.map(weight => (
          <span
            key={weight.category}
            className={`weight-segment cat-${weight.category}`}
            style={{ flexGrow: weight.additions + weight.deletions }}
            title={`${categoryLabels[weight.category]}: ${formatCount(weight.additions + weight.deletions)} lines`}
          />
        ))}
      </div>
      <span className="weight-caption">
        <strong>{formatCount(read)}</strong> of {formatCount(total)} lines to read
      </span>
    </div>
  );
};
