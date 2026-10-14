// Split out of components/message-scroller.tsx so that file exports only components, which Fast Refresh needs to update it
// in place.

export {
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from "@shadcn/react/message-scroller"
