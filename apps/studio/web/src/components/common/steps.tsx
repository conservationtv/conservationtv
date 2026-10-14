import { Children, isValidElement, useState, type FC, type ReactElement, type ReactNode } from 'react';
import { AnimatePresence, motion, type Variants } from 'motion/react';

export interface StepsProps {
  /** Which step to show: the Step whose value is, or includes, this. */
  active: string;
  /** Step elements, in the order the flow moves through them. */
  children: ReactNode;
}

/**
 * Shows one of its Step children at a time, sliding sideways between them: a later step comes in from the right and
 * the one it replaces leaves to the left, an earlier one the other way. "Later" is just the order the steps are
 * written in. The first step shown is already in place. A Step can cover several values, so whatever it holds stays
 * still while a Steps nested inside it moves through them.
 */
export const Steps: FC<StepsProps> = ({ active, children }) => {
  const steps = Children.toArray(children).filter((child): child is ReactElement<StepProps> =>
    isValidElement<StepProps>(child)
  );
  const index = steps.findIndex(({ props }) => [props.value].flat().includes(active));
  // Which way the latest change went, worked out while rendering it, so both the leaving and the arriving step see it
  // (AnimatePresence hands the leaving one the latest `custom`).
  const [shown, setShown] = useState({ index, direction: 0 });
  if (shown.index !== index) setShown({ index, direction: index < shown.index ? -1 : 1 });
  return (
    <AnimatePresence mode="wait" custom={shown.direction}>
      {index !== -1 && (
        <motion.div
          key={index}
          // Lays a step out as a card does, should it hold a header as well as content.
          className="flex flex-col gap-(--card-spacing)"
          custom={shown.direction}
          variants={slide}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        >
          {/* The element from this render: a leaving step keeps showing what it showed. */}
          {steps[index]}
        </motion.div>
      )}
    </AnimatePresence>
  );
};

/** The motion `custom` value is the direction: 1 forward, -1 back, 0 for the first step, which doesn't move. */
const slide: Variants = {
  enter: (direction: number) => ({ opacity: direction ? 0 : 1, x: direction * 24 }),
  center: { opacity: 1, x: 0 },
  exit: (direction: number) => ({ opacity: 0, x: direction * -24 })
};

export interface StepProps {
  /** The value, or values, of Steps' `active` that show this step. */
  value: string | readonly string[];
  children: ReactNode;
}

/** One of Steps' children. */
export const Step: FC<StepProps> = ({ children }) => {
  return children;
};
