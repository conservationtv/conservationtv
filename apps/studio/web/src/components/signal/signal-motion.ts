import type { TargetAndTransition, Transition, Variants } from 'motion/react';

// The signal view's motion, in one place: a few transitions, and what moves how. Small movements, all of them:
// things come up into place and the links wipe in the way the signal runs; groups open and shut on a spring, their
// wires keeping to them; a change of state swaps words and pops the dots it touches.

/** Things that move or resize: a soft spring that settles without much bounce. */
export const spring: Transition = { type: 'spring', duration: 0.45, bounce: 0.12 };
/** Things that swap in place: short, and out of the way. */
export const quick: Transition = { duration: 0.2, ease: [0.2, 0, 0, 1] };
/** Giving under a press, and coming back. */
export const tap: Transition = { type: 'spring', duration: 0.25, bounce: 0.3 };
export const pressed: TargetAndTransition = { scale: 0.985 };

/**
 * The first draw. Things come up one after another, a step apart; the links then run the way the signal does: out of
 * the sources and along the rails, then on from the broadcasts to the channels. Once it's over, a link that arrives
 * draws itself in a little quicker.
 */
export const intro = {
  /** Seconds between one thing coming up and the next. */
  step: 0.035,
  /** The sources' links, out to the rails and off them. */
  feeds: { delay: 0.45, duration: 0.75 },
  /** The broadcasts' links, on to the channels. */
  onward: { delay: 1.05, duration: 0.6 },
  /** The ports and the rails' trunks, fading in as their links are drawn. */
  ports: { delay: 0.8, duration: 0.5 },
  /** How long it all takes, start to finish. */
  settledAfter: 1.8
};

/** A link, a port, arriving after the first draw. */
export const arrival = {
  link: { delay: 0.15, duration: 0.5 },
  ports: { delay: 0.3, duration: 0.3 }
};

/** How long links are measured every frame after a change, to keep to nodes that are still moving. */
export const FOLLOW_MS = 1200;

/**
 * One of the things a parent brings in one after another. On first draw it comes up into place (`before` to `drawn`,
 * played by a column or the stack); as its group opens it drops in from just above (`shut` to `open`, played by the
 * group's contents). It answers to whichever is playing above it.
 */
export const item: Variants = {
  before: { opacity: 0, y: 8 },
  drawn: { opacity: 1, y: 0, transition: spring },
  shut: { opacity: 0, y: -6 },
  open: { opacity: 1, y: 0, transition: spring }
};

/** What plays `drawn`: its items come up a step apart, the first of them `order` steps in. */
export const drawing = (order: number, every = 1): Variants => ({
  drawn: { transition: { delayChildren: order * intro.step, staggerChildren: every * intro.step } }
});

/** A group's members opening under it, one after another. */
export const members: Variants = {
  shut: { height: 0, opacity: 0 },
  open: { height: 'auto', opacity: 1, transition: { ...spring, staggerChildren: 0.03, delayChildren: 0.03 } }
};

/**
 * The same, for members that are raised cards: deeper than its rows by their shadows, which the clip would otherwise
 * cut; the depth is taken back by a margin that opens with it, so nothing jumps as it arrives or leaves.
 */
export const raisedMembers: Variants = {
  shut: { ...members.shut, marginBottom: 0 },
  open: { ...members.open, marginBottom: -8 }
};

/** A rail between the columns: shut it takes no room, and its margins take back the map's gap on either side. */
export const rail = {
  shut: { width: 0, marginLeft: -40, marginRight: -40, opacity: 0 },
  open: { width: 24, marginLeft: -32, marginRight: -32, opacity: 1 }
};
