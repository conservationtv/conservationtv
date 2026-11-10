import { cva } from "class-variance-authority"

// Split out of components/tabs.tsx so that file exports only components, which Fast Refresh needs to update it
// in place.

export const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
      // Compact: a shorter list with smaller labels, for tabs inside a card rather than across a page.
      size: {
        default: "",
        sm: "group-data-horizontal/tabs:h-7",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)
