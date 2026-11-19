import type { StoreFromStoreConfig } from '@xstate/store';

/**
 * How the signal view is being looked at: what's open, what's picked, and whether it has the room for the map. Nothing
 * else: what the view is of comes in as data (<Signal system>), and anything a page adds on top (editing, say) keeps
 * its own state.
 */
interface SignalView {
  /**
   * What's open, by depth: a network, then a subgroup in it. One at each level, so opening one shuts whichever was
   * open beside it, and everything that was open inside that.
   */
  open: string[];
  /** A thing whose path stays in full while the rest fades. */
  picked: string | null;
  /** Whether its canvas is wide enough for the map, as SignalCanvas measures it; the stack shows while it isn't. */
  wide: boolean;
}

interface ToggleEvent {
  /** How deep the group is: 0 for a network, 1 for a subgroup in one. */
  depth: number;
  id: string;
}

interface PickEvent {
  id: string;
}

interface MeasureEvent {
  wide: boolean;
}

/** `open` is what's open to begin with. */
export function signalStoreConfig(open: string[]) {
  const context: SignalView = { open, picked: null, wide: true };
  return {
    context,
    on: {
      /** Open a group, or shut it if it's the one that's open. */
      toggle: (view: SignalView, event: ToggleEvent): SignalView => {
        const above = view.open.slice(0, event.depth);
        return { ...view, open: view.open[event.depth] === event.id ? above : [...above, event.id] };
      },
      /** Pick a thing, or let go of it if it's the one that's picked. */
      pick: (view: SignalView, event: PickEvent): SignalView => ({
        ...view,
        picked: view.picked === event.id ? null : event.id
      }),
      release: (view: SignalView): SignalView => ({ ...view, picked: null }),
      /** The canvas has been measured, wider or narrower than the map needs. */
      measure: (view: SignalView, event: MeasureEvent): SignalView =>
        view.wide === event.wide ? view : { ...view, wide: event.wide }
    }
  };
}

export type SignalStore = StoreFromStoreConfig<ReturnType<typeof signalStoreConfig>>;
