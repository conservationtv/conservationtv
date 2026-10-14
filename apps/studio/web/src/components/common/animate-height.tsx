import { useCallback, type FC, type ReactNode } from 'react';
import { animate, motion, useMotionValue, type AnimationPlaybackControls, type Transition } from 'motion/react';

export interface AnimateHeightProps {
  children: ReactNode;
  className?: string;
  transition?: Transition;
}

/** What the observer tracks between resizes: the height being headed for, and the animation heading there. */
interface Settling {
  target?: number;
  running?: AnimationPlaybackControls;
}

const DEFAULT_TRANSITION: Transition = { duration: 0.3, ease: [0.22, 1, 0.36, 1] };

/**
 * Eases its height to fit its children whenever they change size: an inner div is measured, and this outer one
 * follows it. It clips only while it moves; at rest, focus rings and shadows spill as usual. The first measurement is
 * taken as it is, without animating.
 */
export const AnimateHeight: FC<AnimateHeightProps> = ({ children, className, transition = DEFAULT_TRANSITION }) => {
  const height = useMotionValue<number | 'auto'>('auto');
  const overflow = useMotionValue('visible');

  const measure = useCallback(
    (node: HTMLDivElement) => {
      const state: Settling = {};
      const observer = new ResizeObserver(([entry]) => {
        const next = entry?.borderBoxSize[0]?.blockSize ?? node.offsetHeight;
        if (next === state.target) return;
        if (state.target === undefined) {
          state.target = next;
          height.set(next);
          return;
        }
        state.target = next;
        // Clip rather than hidden: a hidden box can still be scrolled, and focusing something it cuts off (an
        // autofocused field arriving mid-resize) would scroll the whole contents up inside it.
        overflow.set('clip');
        // A new size mid-way takes over from where the height has got to; only the latest settling unclips.
        const controls = animate(height, next, transition);
        state.running = controls;
        void controls.then(() => {
          if (state.running !== controls) return;
          state.running = undefined;
          overflow.set('visible');
        });
      });
      observer.observe(node);
      return () => {
        observer.disconnect();
        state.running?.stop();
      };
    },
    [height, overflow, transition]
  );

  return (
    <motion.div className={className} style={{ height, overflow }}>
      <div ref={measure}>{children}</div>
    </motion.div>
  );
};
