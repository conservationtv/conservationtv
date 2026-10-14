import * as React from "react"

// Split out of components/combobox.tsx so that file exports only components, which Fast Refresh needs to update it
// in place.

/** A ref for the element a Combobox's popup anchors to. */
export function useComboboxAnchor() {
  return React.useRef<HTMLDivElement | null>(null)
}
