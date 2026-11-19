import type { ComponentProps, FC } from 'react';
import { TabsList, TabsTrigger } from '@conservationtv/ui/components/tabs';
import { cn } from '@conservationtv/ui/lib/utils';

// A page's tabs: a line of them across the page under its header, with a rule beneath, and any of the page's actions
// that go with them (watching it live) at the line's end. When the line doesn't fit, the tabs scroll sideways and
// the actions keep their place, showing only their icons. Composed inside a Tabs:
//
//   <Tabs {...tabs}>
//     <PageTabsBar>
//       <PageTabsList>
//         <PageTabsTrigger value="configuration">Configuration</PageTabsTrigger>
//         …
//       </PageTabsList>
//       <PageTabsActions>
//         <Button variant="ghost" size="sm">
//           <PlayIcon />
//           <PageTabsActionLabel>Watch live</PageTabsActionLabel>
//         </Button>
//       </PageTabsActions>
//     </PageTabsBar>
//     <TabsContent value="configuration">…</TabsContent>
//   </Tabs>

/** The line the tabs and their actions sit on, ruled beneath. Its width decides when the actions' labels go. */
export const PageTabsBar: FC<ComponentProps<'div'>> = ({ className, ...props }) => {
  return (
    <div
      data-slot="page-tabs-bar"
      className={cn('@container/page-tabs flex items-center gap-4 border-b border-border pb-0.5', className)}
      {...props}
    />
  );
};

/**
 * The tabs, from the line's start, taking the room the actions leave and scrolling sideways within it. Room beneath
 * them for the current tab's underline, which the scrolling would otherwise clip.
 */
export const PageTabsList: FC<ComponentProps<typeof TabsList>> = ({ className, ...props }) => {
  return <TabsList variant="line" className={cn('min-w-0 flex-1 justify-start pb-1', className)} {...props} />;
};

/** One tab, as wide as its label. */
export const PageTabsTrigger: FC<ComponentProps<typeof TabsTrigger>> = ({ className, ...props }) => {
  return <TabsTrigger className={cn('flex-none px-2 text-custom-13', className)} {...props} />;
};

/** What the page offers beside its tabs, at the line's end. */
export const PageTabsActions: FC<ComponentProps<'div'>> = ({ className, ...props }) => {
  return <div className={cn('flex shrink-0 items-center gap-1', className)} {...props} />;
};

/** An action's words, beside its icon: read out, but not shown, while the line is too narrow for them. */
export const PageTabsActionLabel: FC<ComponentProps<'span'>> = ({ className, ...props }) => {
  return <span className={cn('@max-md/page-tabs:sr-only', className)} {...props} />;
};
