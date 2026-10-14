import type { CSSProperties, FC } from 'react';

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
export const BrandMark: FC = () => {
  return <div aria-hidden className="brand-mark-fill aspect-121/42 h-12" style={stencil} />;
};
