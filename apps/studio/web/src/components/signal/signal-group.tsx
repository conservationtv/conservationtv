import { Children, cloneElement, createContext, use, type FC, type ReactElement, type ReactNode } from 'react';
import { AnimatePresence, motion, type HTMLMotionProps, type Variants } from 'motion/react';
import { cn } from '@conservationtv/ui/lib/utils';

import {
  SignalGroupContext,
  SignalItemContext,
  useSignalGroup,
  useSignalItem,
  useSignalOpen,
  useSignalStanding,
  useSignalStore,
  type SignalGroupContextValue
} from '@/components/signal/signal-context';
import { item, members, raisedMembers, spring } from '@/components/signal/signal-motion';
import { Appear, Caret, Swap } from '@/components/signal/signal-presence';

// A group of sources that opens and shuts: a network, or a subgroup inside one (the same parts, nested). One at each
// level is open at a time. The map and the stack draw it differently and share these: the group, what's pressed to
// open it, and its members coming in under it one after another.

export interface SignalGroupProps extends HTMLMotionProps<'div'> {
  /** What the page's open groups name it by. */
  id: string;
  /** Open (or shut) whatever is pressed: for a group that's always listed, and has no label to press. */
  open?: boolean;
  children?: ReactNode;
}

/** A group: its label, then its members. Nest one inside another's content for a group within a group. */
export const SignalGroup: FC<SignalGroupProps> = ({ id, open: fixed, className, children, ...props }) => {
  const parent = use(SignalGroupContext);
  const depth = parent ? parent.depth + 1 : 0;
  const store = useSignalStore();
  const chosen = useSignalOpen(id, depth);
  const isItem = useSignalItem();
  const group: SignalGroupContextValue = {
    id,
    depth,
    open: fixed ?? chosen,
    toggle: fixed === undefined ? () => store.trigger.toggle({ depth, id }) : undefined
  };
  return (
    <SignalGroupContext value={group}>
      <SignalItemContext value={false}>
        <motion.div
          variants={isItem ? item : undefined}
          layout={isItem ? 'position' : undefined}
          transition={{ layout: spring }}
          className={cn('flex flex-col', className)}
          {...props}
        >
          {children}
        </motion.div>
      </SignalItemContext>
    </SignalGroupContext>
  );
};

/** What a group's trigger gives whatever it renders: something for a press to do, and whether it's open. */
interface SignalGroupTriggerTarget {
  onClick?: () => void;
  'aria-expanded'?: boolean | 'true' | 'false';
}

export interface SignalGroupTriggerProps {
  /** What's pressed: a SignalNode on the map, a SignalListItem in the stack. */
  render: ReactElement<SignalGroupTriggerTarget>;
  children: ReactNode;
}

/** The group's label, pressed to open it and again to shut it. */
export const SignalGroupTrigger: FC<SignalGroupTriggerProps> = ({ render, children }) => {
  const group = useSignalGroup();
  return cloneElement(render, { onClick: group.toggle, 'aria-expanded': group.open }, children);
};

/** The group's caret, turning as it opens. */
export const SignalGroupCaret: FC = () => {
  const group = useSignalGroup();
  return <Caret open={group.open} />;
};

export interface SignalGroupShutProps {
  className?: string;
  children: ReactNode;
}

/** Something that's only there while the group is shut: its members at a glance, say. */
export const SignalGroupShut: FC<SignalGroupShutProps> = ({ className, children }) => {
  const group = useSignalGroup();
  return (
    <Appear when={!group.open} className={className}>
      {children}
    </Appear>
  );
};

export interface SignalGroupNoteProps {
  tone?: 'default' | 'destructive';
  /** What it says; a change of words swaps in place. */
  children: string;
}

/**
 * A line under the group's label, not beside it, so the label's line has room for the dots whatever the column's
 * width. It fades back with the label when something off the group is picked.
 */
export const SignalGroupNote: FC<SignalGroupNoteProps> = ({ tone = 'default', children }) => {
  const group = useSignalGroup();
  const standing = useSignalStanding(group.id);
  return (
    <div
      className={cn(
        'flex pl-5.5 text-custom-11 transition-opacity duration-200',
        tone === 'destructive' ? 'text-destructive' : 'text-muted-foreground',
        standing.dimmed && 'opacity-25'
      )}
    >
      <Swap id={children} className="truncate">
        {children}
      </Swap>
    </div>
  );
};

export interface SignalGroupContentProps {
  /**
   * Plain rows; or raised cards, whose shadows the clip would cut: it's made wider and deeper than them by their
   * shadows, and the depth is taken back by a margin that opens with it.
   */
  variant?: 'plain' | 'raised';
  className?: string;
  children: ReactNode;
}

interface MembersProps extends SignalGroupContentProps {
  shown: boolean;
}

/** Members, there while `shown`: their height opens on a spring and they come in one after another. */
const Members: FC<MembersProps> = ({ shown, variant = 'plain', className, children }) => {
  const raised = variant === 'raised';
  return (
    <SignalItemContext value>
      <AnimatePresence initial={false}>
        {shown && (
          <motion.div
            key="members"
            className={raised ? '-mx-2' : cn('flex flex-col', className)}
            style={{ overflow: 'clip' }}
            variants={raised ? raisedMembers : members}
            initial="shut"
            animate="open"
            exit="shut"
            transition={spring}
          >
            {raised ? (
              <div className={cn('flex flex-col gap-1.5 px-2 pt-1.5 pb-2', className)}>{children}</div>
            ) : (
              children
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </SignalItemContext>
  );
};

/** The group's members, there while it's open. */
export const SignalGroupContent: FC<SignalGroupContentProps> = props => {
  const group = useSignalGroup();
  return <Members shown={group.open} {...props} />;
};

/**
 * What's on show while the group is shut that has a place of its own once it's open, there only while it's shut: a
 * network's stopped cameras that are in its subgroups, say, which open into their subgroups instead. Put it before the
 * group's content, and give it nothing when there's nothing to show. A member of the group's own is no such thing:
 * that is one SignalGroupMember, kept (so it never leaves the page, and its links never let go of it).
 */
export const SignalGroupShutContent: FC<SignalGroupContentProps> = props => {
  const group = useSignalGroup();
  return <Members shown={!group.open && Children.count(props.children) > 0} {...props} />;
};

/** The room between one member and the next, and above the first, in pixels. */
const MemberGapContext = createContext(0);

const memberGaps = { plain: 0, raised: 6 } satisfies Record<NonNullable<SignalGroupContentProps['variant']>, number>;

/**
 * The group's own members, each coming and going by itself (SignalGroupMember), rather than all at once as its
 * content does: so one that's on show either way (a stopped camera) stays put, the same element, while the rest open
 * in around it. Put it after the group's content.
 */
export const SignalGroupMembers: FC<SignalGroupContentProps> = ({ variant = 'plain', className, children }) => {
  return (
    <MemberGapContext value={memberGaps[variant]}>
      <SignalItemContext value>
        <div className={cn('flex flex-col', className)}>{children}</div>
      </SignalItemContext>
    </MemberGapContext>
  );
};

/** A member as it comes and goes: its height opens, and the room above it with it; clipped only while it moves. */
const member: Variants = {
  shut: { height: 0, opacity: 0, marginTop: 0, overflow: 'clip' },
  open: (gap: number) => ({
    height: 'auto',
    opacity: 1,
    marginTop: gap,
    transition: spring,
    transitionEnd: { overflow: 'visible' }
  })
};

export interface SignalGroupMemberProps {
  /** On show even while the group is shut: a camera that has stopped, say. */
  kept?: boolean;
  children: ReactNode;
}

/** One of a SignalGroupMembers: there while the group is open, or while it's kept. */
export const SignalGroupMember: FC<SignalGroupMemberProps> = ({ kept = false, children }) => {
  const group = useSignalGroup();
  const gap = use(MemberGapContext);
  return (
    <AnimatePresence initial={false}>
      {(group.open || kept) && (
        <motion.div
          key="member"
          // Room for a raised card's shadow, while it's clipped.
          className="-mx-2 px-2"
          transition={spring}
          custom={gap}
          variants={member}
          initial="shut"
          animate="open"
          exit="shut"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
};
