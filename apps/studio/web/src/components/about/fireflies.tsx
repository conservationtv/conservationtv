import type { FC } from 'react';
import { motion } from 'motion/react';
import { cn } from '@conservationtv/ui/lib/utils';

import { seeded } from '@/components/about/seeded';

/**
 * Where the fireflies hover, as percentages of the landscape: three around the wolves and three around the emus. The
 * night landscape has their light baked into it at these same spots, so keep the two in step if either moves.
 */
const HOMES: [x: number, y: number][] = [
  [10.2, 36.7],
  [18.8, 41.9],
  [12.3, 48.3],
  [78.4, 33.8],
  [85.3, 27.4],
  [88.2, 34.5]
];

/** A few strays dotted along the water's edge, away from the animals. Fainter, and with no light baked in for them. */
const STRAYS: [x: number, y: number][] = [
  [14, 78],
  [25, 68],
  [34, 59],
  [47, 50.5],
  [89, 48]
];

/** Keyframes for a small loop around home, in full-width pixels, that a firefly wanders and comes back along. */
interface WanderPath {
  x: number[];
  y: number[];
}

interface Firefly {
  x: number;
  y: number;
  path: WanderPath;
  /** Seconds for one wander. */
  wander: number;
  /** How its light pulses, and over how many seconds. */
  pulse: number[];
  flicker: number;
  stray: boolean;
}

/**
 * Sizes are given in pixels as they look with the landscape at its full width, and drawn as a share of the
 * landscape's actual width, so the fireflies scale with the image.
 */
const FULL_WIDTH = 1600;
const scaled = (px: number) => `${(px / FULL_WIDTH) * 100}cqw`;

/** Each firefly gets its own wander and pulse, seeded so they're the same on every visit. */
const FIREFLIES: Firefly[] = (() => {
  const random = seeded(20261015);
  const around = (reach: number) => Array.from({ length: 5 }, () => (random() - 0.5) * 2 * reach);
  const firefly = ([x, y]: [number, number], stray: boolean): Firefly => {
    const strength = stray ? 0.7 : 1;
    return {
      x,
      y,
      path: { x: [0, ...around(14), 0], y: [0, ...around(9), 0] },
      wander: 7 + random() * 6,
      pulse: [1, 0.35 + random() * 0.3, 1, 0.6 + random() * 0.2, 1].map(level => level * strength),
      flicker: 2.5 + random() * 2.5,
      stray
    };
  };
  return [...HOMES.map(home => firefly(home, false)), ...STRAYS.map(home => firefly(home, true))];
})();

export interface FirefliesProps {
  className?: string;
}

/**
 * Fireflies drifting around the animals at night, with a few strays along the water's edge, each a small warm light
 * with a soft glow, wandering a little loop around its spot and pulsing. Decorative. The layer is a size container, so
 * everything in it scales with the landscape. Anyone who prefers reduced motion gets them still (the root's
 * MotionConfig holds back the wandering), though they still glow.
 */
export const Fireflies: FC<FirefliesProps> = ({ className }) => (
  <div aria-hidden className={cn('@container', className)}>
    {FIREFLIES.map((firefly, index) => (
      <motion.div
        key={index}
        className="absolute -translate-1/2"
        style={{ left: `${firefly.x}%`, top: `${firefly.y}%` }}
        animate={{ x: firefly.path.x.map(scaled), y: firefly.path.y.map(scaled), opacity: firefly.pulse }}
        transition={{
          x: { duration: firefly.wander, ease: 'easeInOut', repeat: Infinity },
          y: { duration: firefly.wander, ease: 'easeInOut', repeat: Infinity },
          opacity: { duration: firefly.flicker, ease: 'easeInOut', repeat: Infinity }
        }}
      >
        {/* The faint glow it casts on the air around it. */}
        <div
          className="absolute top-1/2 left-1/2 -translate-1/2 rounded-full bg-[radial-gradient(circle,rgb(255_176_80/0.22),transparent_70%)] mix-blend-screen"
          style={{ width: scaled(firefly.stray ? 28 : 40), height: scaled(firefly.stray ? 28 : 40) }}
        />
        <div
          className="rounded-full bg-[#ffd27a]"
          style={{
            width: scaled(firefly.stray ? 3 : 4),
            height: scaled(firefly.stray ? 3 : 4),
            boxShadow: `0 0 ${scaled(3)} ${scaled(1)} rgb(255 200 110 / 0.9), 0 0 ${scaled(10)} ${scaled(3)} rgb(255 160 60 / 0.45)`
          }}
        />
      </motion.div>
    ))}
  </div>
);
