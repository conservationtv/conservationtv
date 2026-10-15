import type { FC } from 'react';

import { seeded } from '@/components/about/seeded';

interface Star {
  /** Across the sky, as a percentage of its width. */
  x: number;
  /** Down the sky, as a percentage of the hero's height. */
  y: number;
  /** In pixels. */
  radius: number;
  opacity: number;
}

const STAR_COUNT = 140;
/** How far down the hero stars reach, as a percentage: they give out into the glow above the hills. */
const STAR_FIELD_DEPTH = 50;

/**
 * Most stars are faint pinpricks and a few are brighter. They crowd towards the top, where the sky is darkest, and
 * fade as they near the horizon.
 */
const STARS: Star[] = (() => {
  const random = seeded(20261014);
  return Array.from({ length: STAR_COUNT }, () => {
    const y = STAR_FIELD_DEPTH * random() ** 1.6;
    const bright = random() < 0.08;
    const fade = 1 - y / (STAR_FIELD_DEPTH * 1.1);
    return {
      x: random() * 100,
      y,
      radius: bright ? 1.2 + random() * 0.5 : 0.5 + random() * 0.6,
      opacity: (bright ? 0.9 : 0.3 + random() * 0.45) * fade
    };
  });
})();

export interface NightStarsProps {
  className?: string;
}

/**
 * Stars in the night sky, for the dark theme. Decorative. Positioned in percentages without a viewBox, so the
 * field stretches with the hero while each star stays round.
 */
export const NightStars: FC<NightStarsProps> = ({ className }) => (
  <svg aria-hidden className={className}>
    {STARS.map((star, index) => (
      <circle key={index} cx={`${star.x}%`} cy={`${star.y}%`} r={star.radius} fill="white" opacity={star.opacity} />
    ))}
  </svg>
);
