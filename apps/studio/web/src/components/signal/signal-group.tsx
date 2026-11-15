import { Children, cloneElement, use, type FC, type ReactElement, type ReactNode } from 'react';
import { AnimatePresence, motion, type HTMLMotionProps } from 'motion/react';
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
  onPress?: () => void;
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
  return cloneElement(render, { onPress: group.toggle, 'aria-expanded': group.open }, children);
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
 * Those of the group's members that are on show even while it's shut (whatever has stopped), there only while it is:
 * open, they're among the rest in its content. Put it before the SignalGroupContent, and give it nothing when there's
 * nothing to show.
 */
export const SignalGroupShutContent: FC<SignalGroupContentProps> = props => {
  const group = useSignalGroup();
  return <Members shown={!group.open && Children.count(props.children) > 0} {...props} />;
};
