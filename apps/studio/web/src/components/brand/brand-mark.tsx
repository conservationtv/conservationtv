import type { CSSProperties, FC } from 'react';
import { cn } from '@conservationtv/ui/lib/utils';

import logoUrl from '@/assets/logo.svg';
import './brand-mark.css';

/** The logo as a stencil: whatever is painted under it shows through in the shape of the waves. */
const stencil: CSSProperties = {
  maskImage: `url("${logoUrl}")`,
  maskSize: 'contain',
  maskRepeat: 'no-repeat',
  maskPosition: 'center'
};

/**
 * The conservation.tv mark in its gradient, gently swaying back and forth; still for anyone who prefers reduced motion.
 * Decorative: the wordmark beside it names the brand.
 */
export interface BrandMarkProps {
  /** Sizes the mark: give a height and the width follows the logo's proportions. */
  className?: string;
}

export const BrandMark: FC<BrandMarkProps> = ({ className }) => {
  return <div aria-hidden className={cn('brand-mark-fill aspect-121/42 h-12', className)} style={stencil} />;
};
