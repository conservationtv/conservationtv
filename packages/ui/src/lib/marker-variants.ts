import { cva } from "class-variance-authority"

// Split out of components/marker.tsx so that file exports only components, which Fast Refresh needs to update it
// in place.

export const markerVariants = cva(
  "group/marker relative flex min-h-4 w-full items-center gap-2 text-left text-xs/relaxed text-muted-foreground [&_svg:not([class*='size-'])]:size-3.5 [a]:underline [a]:underline-offset-3 [a]:hover:text-foreground",
  {
    variants: {
      variant: {
        default: "",
        separator:
          "before:mr-1 before:h-px before:min-w-0 before:flex-1 before:bg-border after:ml-1 after:h-px after:min-w-0 after:flex-1 after:bg-border",
        border: "border-b border-border pb-2",
      },
    },
  }
)
