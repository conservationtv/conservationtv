import type { ComponentProps, FC } from 'react';
import { motion } from 'motion/react';

/** The butterfly's path through its frame, in pixels: it flies there and back along the same loops. */
const FLIGHT_PATH = {
  x: [
    25.158, 28.013, 30.779, 32.944, 34.761, 36.509, 37.897, 36.5, 33.574, 30.865, 28.65, 26.38, 23.474, 20.618, 17.569,
    16.524, 15.362, 13.042, 9.971, 6.999, 4.076, 1.665, 1.97, 5.031, 7.955, 9.195, 10.253, 12.495, 15.482, 18.499,
    21.412, 24.451, 27.517, 30.347, 33.013, 36.024, 38.984, 40.974, 38.615, 35.989, 33.12, 30.125, 32.018, 34.322,
    36.795, 39.424, 42.094, 43.533, 43.755, 42.955, 40.223, 37.324, 34.362, 31.631, 29.799, 28.594, 27.891, 26.959,
    25.753, 25.298
  ],
  y: [
    19.288, 18.114, 16.758, 14.579, 12.087, 9.534, 6.803, 4.16, 3.69, 5.15, 7.291, 9.367, 9.703, 8.568, 8.652, 11.468,
    14.308, 16.111, 16.145, 15.324, 14.303, 12.495, 10.111, 10.405, 11.366, 14.066, 16.922, 18.995, 19.709, 20.352,
    21.352, 21.902, 22.081, 20.921, 19.393, 18.701, 17.844, 16.467, 18.445, 20.053, 21.169, 21.911, 19.939, 17.88,
    16.032, 14.434, 12.869, 10.347, 7.27, 4.362, 2.966, 1.914, 1.042, 2.2, 4.67, 7.497, 10.502, 13.449, 16.289, 19.257
  ]
};

const REVERSED_FLIGHT_PATH = { x: FLIGHT_PATH.x.toReversed(), y: FLIGHT_PATH.y.toReversed() };

const repeat = <T,>(pattern: T[], count: number): T[] => Array.from({ length: count }, () => pattern).flat();

/** The wings beating as a skew, and the butterfly turning about every sixteen beats to face the way it flies. */
const WING_FLAP = {
  skewX: repeat([20, 0, -20, 0], 17),
  rotateZ: repeat([...Array<number>(16).fill(-180), ...Array<number>(16).fill(0)], 4),
  rotateX: repeat([...Array<number>(16).fill(180), ...Array<number>(16).fill(0)], 4)
};

export interface ButterflyIconProps extends Omit<ComponentProps<'svg'>, 'fill'> {
  fill?: string;
}

export const ButterflyIcon: FC<ButterflyIconProps> = ({ fill = '#d24d34', ...props }) => (
  <svg viewBox="0 0 2.53 2.03" {...props}>
    <path
      fill={fill}
      d="M.93,1.71c.13.13.39.31.58.32.02,0,.06-.01.07-.04.04-.14.05-.27,0-.41.09.03.11.18.19.15.02,0,.01-.04,0-.07.11.03.22.05.33.07.07.01.12,0,.18-.05.14-.09.22-.24.24-.4,0-.08,0-.16-.02-.24-.05-.12-.16-.15-.29-.13.05-.07.13-.21.09-.3-.05-.14-.1-.27-.11-.42,0-.08-.03-.17-.12-.19-.04,0-.1.03-.13.06-.12.11-.2.24-.26.39-.07.16-.12.33-.15.51l-.07.35s-.07-.04-.11,0c-.31-.23-.71-.51-1.07-.65C.24.63,0,.55,0,.63c0,.05.03.07.07.1.16.15.31.3.45.46.04.05.07.08.13.1s.12.03.18.03c-.13.12,0,.28.1.37Z"
    />
  </svg>
);

export interface AnimatedButterflyProps {
  fill?: string;
  /** Seconds for one flight along the path; it then flies back the same way. */
  duration?: number;
  /** Fly the path from its other end, so two butterflies sharing a frame don't fly in step. */
  reverse?: boolean;
  className?: string;
}

/** A butterfly flitting about its frame; it holds still for anyone who prefers reduced motion (see the root's MotionConfig). */
export const AnimatedButterfly: FC<AnimatedButterflyProps> = ({
  fill = '#d24d34',
  duration = 8,
  reverse = false,
  className
}) => {
  const path = reverse ? REVERSED_FLIGHT_PATH : FLIGHT_PATH;
  return (
    <motion.div
      className={className}
      animate={{
        x: path.x,
        y: path.y,
        ...WING_FLAP,
        transition: { duration, ease: 'circInOut', repeat: Infinity, repeatType: 'mirror' }
      }}
      style={{ width: 10, height: 10 }}
    >
      <ButterflyIcon fill={fill} className="size-full" />
    </motion.div>
  );
};
