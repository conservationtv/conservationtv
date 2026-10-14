import { useId, type FC } from 'react';
import { motion, useReducedMotion } from 'motion/react';

/** When the first brush lands, in seconds: just after the card it sits above starts to rise. */
const FIRST_STROKE_DELAY = 0.15;
/** How long each brush takes to cross its wave, in seconds. */
const STROKE_DURATION = 0.6;
/** Seconds between one wave's brush landing and the next's, unless BrushedBrandMark is given another. */
const DEFAULT_STAGGER = 0.225;

export interface BrushedBrandMarkProps {
  /** Seconds between one wave's brush landing and the next's. */
  stagger?: number;
}

/**
 * The conservation.tv mark, painted on: its three waves are brushed in left to right, one after another, then the
 * gradient sways as BrandMark's does. Each wave is masked by a thick, rough-edged stroke along its centreline that
 * draws itself on, so the shape appears behind a ragged leading edge, like paint off a brush. Already painted, and
 * still, for anyone who prefers reduced motion. Decorative: the wordmark beside it names the brand.
 *
 * The centrelines and widths were sampled from src/assets/logo.svg's outlines (the midpoint and half-thickness across
 * each wave), with a short lead-in and lift-off beyond the tips so the brush lands and leaves off the shape.
 */
export const BrushedBrandMark: FC<BrushedBrandMarkProps> = ({ stagger = DEFAULT_STAGGER }) => {
  const id = useId();
  const still = useReducedMotion() ?? false;
  const fill = `url(#${id}-fill)`;
  const bristles = `url(#${id}-bristles)`;
  return (
    <svg aria-hidden viewBox="0 0 121 42" className="h-12 w-auto overflow-visible">
      <defs>
        {/* The logo's gradient, 30% wider than the mark and drifting from one end to the other and back, as in
            brand-mark.css; held at centre when still. */}
        <motion.linearGradient
          id={`${id}-fill`}
          gradientUnits="userSpaceOnUse"
          y1={0}
          y2={0}
          initial={still ? { x1: -18.15, x2: 139.15 } : { x1: 0, x2: 157.3 }}
          animate={still ? undefined : { x1: -36.3, x2: 121 }}
          transition={{ duration: 6, ease: 'easeInOut', repeat: Infinity, repeatType: 'reverse' }}
        >
          <stop offset={0} stopColor="#ffce51" />
          <stop offset={0.5} stopColor="#ff715b" />
          <stop offset={1} stopColor="#c43f98" />
        </motion.linearGradient>
        {/* Roughens the brush's edges, so the leading edge reads as bristles rather than a clean round cap. Its region
            is the whole mark and then some: by default a filter's region comes from the path's geometry, which for a
            stroke is just its centreline, so the stroke's width would be cut off flat above and below it. */}
        <filter id={`${id}-bristles`} filterUnits="userSpaceOnUse" x={-20} y={-20} width={161} height={82}>
          <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves={2} seed={4} />
          <feDisplacementMap in="SourceGraphic" scale={4} xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
      <BrushStroke
        wave="M0 32.3948C8.12718 20.2284 19.5443 11.0589 31.222 11.0589C41.3851 11.0589 49.7729 17.1665 56.988 24.1536C63.8285 30.9127 70.6364 36.6294 79.6268 37.7532C74.3824 40.0985 69.3497 41.2874 64.4311 41.2874C55.4081 41.2874 49.1051 37.7369 42.8835 34.2026C36.1081 30.2775 29.235 26.4338 19.8701 26.4338C13.453 26.4338 6.61249 28.4371 0 32.3948Z"
        spine="M-3 34.6 L1.6 30.8 L7.1 26.2 L12.5 22.9 L18 20.7 L23.4 19.5 L28.9 19.4 L34.4 20.5 L39.8 22.5 L45.3 25.3 L50.7 28.5 L56.2 31.8 L61.7 34.9 L67.1 37 L72.6 38 L78 38 L84 37.9"
        width={25}
        delay={FIRST_STROKE_DELAY}
        fill={fill}
        bristles={bristles}
        still={still}
      />
      <BrushStroke
        wave="M33.2253 7.70372C39.9356 2.57334 47.2647 0 54.5286 0C64.6265 0 71.5159 5.55384 78.2099 12.1012C85.5553 19.414 93.4707 27.1666 105.23 27.1666C106.777 27.1666 108.243 27.0526 109.644 26.906C101.858 32.3296 93.9267 35.0658 86.9396 35.0658C76.4509 35.0658 68.6006 28.7301 61.8252 22.1665C53.926 14.3325 44.8542 7.21511 33.2253 7.70372Z"
        spine="M28.9 8.5 L34.8 7.1 L40 5.9 L45.2 5.7 L50.5 6.5 L55.7 8.3 L61 11.1 L66.2 14.5 L71.4 18.1 L76.7 21.8 L81.9 25.1 L87.2 27.7 L92.4 29.2 L97.6 29.6 L102.9 29 L108.1 27.5 L113.9 25.8"
        width={28}
        delay={FIRST_STROKE_DELAY + stagger}
        fill={fill}
        bristles={bristles}
        still={still}
      />
      <BrushStroke
        wave="M84.2033 12.3779C88.0307 9.42998 92.2653 8.04559 96.5162 8.04559C102.103 8.04559 106.288 10.4723 109.937 13.6646C113.08 16.4822 116.37 19.0881 120.311 20.2445C115.686 22.5898 111.093 23.6322 106.875 23.6322C100.23 23.6322 94.8712 21.0914 90.5063 17.5246C88.3076 15.7004 86.1903 13.8926 84.2033 12.3779Z"
        spine="M79 11.8 L84.9 12.4 L87.4 12.6 L89.9 13.1 L92.4 13.7 L94.8 14.3 L97.3 14.9 L99.8 15.5 L102.3 16.1 L104.7 16.8 L107.2 17.6 L109.7 18.5 L112.2 19.3 L114.6 20 L117.1 20.3 L119.6 20.3 L125.6 20.3"
        width={18}
        delay={FIRST_STROKE_DELAY + stagger * 2}
        fill={fill}
        bristles={bristles}
        still={still}
      />
    </svg>
  );
};

interface BrushStrokeProps {
  /** The wave's outline. */
  wave: string;
  /** The brush's path along the wave, from where it lands to where it lifts off. */
  spine: string;
  /** The brush's width: enough to cover the wave at its thickest, bristles and all. */
  width: number;
  /** When the brush lands, in seconds. */
  delay: number;
  fill: string;
  bristles: string;
  still: boolean;
}

/** One wave, revealed by a brush drawn along it: quick off the mark, slowing as it lifts, like a real stroke. */
const BrushStroke: FC<BrushStrokeProps> = ({ wave, spine, width, delay, fill, bristles, still }) => {
  const id = useId();
  return (
    <>
      <mask id={id} maskUnits="userSpaceOnUse" x={-20} y={-20} width={161} height={82}>
        <motion.path
          d={spine}
          fill="none"
          stroke="white"
          strokeWidth={width}
          strokeLinecap="round"
          strokeLinejoin="round"
          filter={bristles}
          // Hidden until the brush lands, or its round cap would sit at the start as a dot.
          initial={still ? false : { pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{
            pathLength: { duration: STROKE_DURATION, delay, ease: [0.3, 0.6, 0.35, 1] },
            opacity: { duration: 0.05, delay }
          }}
        />
      </mask>
      <path d={wave} fill={fill} mask={`url(#${id})`} />
    </>
  );
};
