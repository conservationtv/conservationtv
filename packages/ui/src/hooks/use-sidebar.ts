import * as React from "react"

// Split out of sidebar.tsx so that file exports only components, which Fast Refresh needs to update it in place.

declare module "react" {
  interface CSSProperties {
    /** The sidebar's width, read by its layout; set it on SidebarProvider's `style` to resize the sidebar. */
    "--sidebar-width"?: string
    /** The collapsed (icon-only) sidebar's width. */
    "--sidebar-width-icon"?: string
  }
}

export type SidebarContextProps = {
  state: "expanded" | "collapsed"
  open: boolean
  setOpen: (open: boolean) => void
  openMobile: boolean
  setOpenMobile: (open: boolean) => void
  isMobile: boolean
  toggleSidebar: () => void
}

export const SidebarContext = React.createContext<SidebarContextProps | null>(
  null
)

export function useSidebar() {
  const context = React.useContext(SidebarContext)
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.")
  }

  return context
}
