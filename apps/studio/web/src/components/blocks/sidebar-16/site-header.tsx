import { SearchForm } from "@/components/blocks/sidebar-16/search-form"
import { PreviewControls } from "@/components/previews/preview-controls"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@conservationtv/ui/components/breadcrumb"
import { Button } from "@conservationtv/ui/components/button"
import { Separator } from "@conservationtv/ui/components/separator"
import { useSidebar } from "@conservationtv/ui/hooks/use-sidebar"
import { SidebarIcon } from "@phosphor-icons/react"

export function SiteHeader() {
  const { toggleSidebar } = useSidebar()

  return (
    <header className="sticky top-0 z-50 flex w-full items-center border-b bg-background">
      <div className="flex h-(--header-height) w-full items-center gap-2 px-4">
        <Button
          className="h-8 w-8"
          variant="ghost"
          size="icon"
          onClick={toggleSidebar}
          aria-label="Toggle sidebar"
        >
          <SidebarIcon />
        </Button>
        <Separator
          orientation="vertical"
          className="mr-2 data-vertical:h-4 data-vertical:self-auto"
        />
        <Breadcrumb className="hidden xl:block">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/sidebar-07">Sidebar blocks</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Sticky header</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <SearchForm className="ml-auto hidden md:block md:w-40 lg:w-56" />
        <PreviewControls />
      </div>
    </header>
  )
}
