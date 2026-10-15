import { useId, type CSSProperties, type FC, type ReactNode } from 'react';
import { motion } from 'motion/react';

export interface FramePosition {
  /** 0 = left edge, 1 = right edge */
  x: number;
  /** 0 = top edge, 1 = bottom edge */
  y: number;
}

export interface FrameDimensions {
  width: number;
  height: number;
}

/** As fractions of the container, so the frame scales with the illustration, or fixed in rem. */
export interface FrameSize {
  percentage?: FrameDimensions;
  absolute?: FrameDimensions;
}

export interface FrameProps {
  /** Where the frame's top-left corner sits in its container, as fractions of its width and height. */
  position: FramePosition;
  size: FrameSize;
  /** The corner brackets' size and offset, in pixels. */
  corner: number;
  /** A soft shadow on the ground beneath the frame. */
  shadow?: boolean;
  children?: ReactNode;
}

/** The brackets, clockwise from the top left: the sides each one sits against, and its turn from the first. */
const CORNERS = [
  { vertical: 'top', horizontal: 'left', rotate: '0deg' },
  { vertical: 'top', horizontal: 'right', rotate: '90deg' },
  { vertical: 'bottom', horizontal: 'right', rotate: '180deg' },
  { vertical: 'bottom', horizontal: 'left', rotate: '270deg' }
] as const;

interface CornerBracketProps {
  corner: number;
  rotate: string;
  style: CSSProperties;
}

const CornerBracket: FC<CornerBracketProps> = ({ corner, rotate, style }) => (
  <svg
    className="absolute stroke-1 lg:stroke-2"
    style={{ ...style, rotate }}
    width={corner * 3}
    height={corner * 3}
    viewBox="0 0 5 5"
    fill="none"
  >
    <path d="M4 1H1V4" stroke="white" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const FrameShadow: FC = () => {
  // Each frame's shadow has its own filter, so the ids stay unique on the page.
  const filterId = useId();
  return (
    <svg
      className="absolute -bottom-[20%] left-1/2 w-[130%] -translate-x-1/2 opacity-15"
      viewBox="0 0 135 17"
      fill="none"
    >
      <g filter={`url(#${CSS.escape(filterId)})`} style={{ mixBlendMode: 'multiply' }}>
        <ellipse cx="67.3" cy="8.30005" rx="62" ry="3" fill="black" />
      </g>
      <defs>
        <filter
          id={filterId}
          x="4.86374e-05"
          y="4.86374e-05"
          width="134.6"
          height="16.6"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="2.65" result="effect1_foregroundBlur" />
        </filter>
      </defs>
    </svg>
  );
};

/** A camera's viewfinder over the illustration: white corner brackets around a faint border, brightening on hover. */
export const Frame: FC<FrameProps> = ({ position, size, corner, shadow, children }) => (
  <motion.div
    whileHover={{ backgroundColor: 'rgba(255, 255, 255, 0.1)', scale: 1.02 }}
    className="pointer-events-auto absolute rounded-[5px] border-2 border-white/10"
    style={{
      left: `${position.x * 100}%`,
      top: `${position.y * 100}%`,
      width: size.percentage ? `${size.percentage.width * 100}%` : `${size.absolute?.width}rem`,
      height: size.percentage ? `${size.percentage.height * 100}%` : `${size.absolute?.height}rem`
    }}
  >
    {children}
    {/* Each bracket sits out from its corner by its own size. */}
    {CORNERS.map(({ vertical, horizontal, rotate }) => (
      <CornerBracket
        key={`${vertical}-${horizontal}`}
        corner={corner}
        rotate={rotate}
        style={{ [vertical]: -corner, [horizontal]: -corner }}
      />
    ))}
    {shadow && <FrameShadow />}
  </motion.div>
);
