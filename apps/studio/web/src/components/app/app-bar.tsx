import { Suspense, type ComponentProps, type FC } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { ListIcon, RecordIcon, SignOutIcon, UserCircleGearIcon, UserCircleIcon } from '@phosphor-icons/react';
import { Link, NavLink } from 'react-router';
import { Button } from '@conservationtv/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@conservationtv/ui/components/dropdown-menu';
import { useSidebar } from '@conservationtv/ui/hooks/use-sidebar';
import { buttonVariants } from '@conservationtv/ui/lib/button-variants';
import { cn } from '@conservationtv/ui/lib/utils';

import { PinIcon } from '@/components/app/pins';
import { BrandMark } from '@/components/brand/brand-mark';
import { useSignOutOfStudio } from '@/hooks/use-sign-out-of-studio';
import { appHomePath } from '@/lib/route-guards';
import { pinListQueryOptions } from '@/queries/this-device';

// The bar across the top of a phone's screen, where neither the app's rail nor an organisation's sidebar fits beside
// the page. Each pane layout composes its own above its page, as shadcn's SidebarInset header does: an organisation's
// with a button sliding out its sidebar, the pages outside one without. Between them, its parts carry what the rail
// does on a wider screen: home, the pins, the account and signing out.
//
//   <AppBar>
//     <AppBarSidebarTrigger />
//     <AppBarHome />
//     <AppBarTitle>Serval Reserve</AppBarTitle>
//     <AppBarGoLive />
//     <AppBarAccount />
//   </AppBar>

/** The bar: only below the width the rail and sidebars need (`md`, where useIsMobile turns them into sheets). */
export const AppBar: FC<ComponentProps<'header'>> = ({ className, ...props }) => {
  return (
    <header
      className={cn(
        'flex h-12 shrink-0 items-center gap-1 border-b border-border bg-background px-2 md:hidden',
        className
      )}
      {...props}
    />
  );
};

/** Slides out the sidebar of the SidebarProvider it is under, and says whether it is out. */
export const AppBarSidebarTrigger: FC = () => {
  const sidebar = useSidebar();
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-9"
      aria-expanded={sidebar.openMobile}
      aria-label="Open navigation"
      onClick={() => sidebar.setOpenMobile(true)}
    >
      <ListIcon />
    </Button>
  );
};

/** The brand mark, home: the rail's first link. */
export const AppBarHome: FC = () => {
  return (
    <NavLink
      to={appHomePath}
      end
      className="flex size-9 shrink-0 items-center justify-center rounded-lg focus-visible:outline-2 focus-visible:outline-ring"
    >
      <BrandMark className="h-auto w-6" />
      <span className="sr-only">Home</span>
    </NavLink>
  );
};

/** What the bar is over, in a line, cut to fit: the organisation, say. Takes the room between the ends. */
export const AppBarTitle: FC<ComponentProps<'span'>> = ({ className, ...props }) => {
  return <span className={cn('min-w-0 flex-1 truncate text-sm font-medium text-foreground', className)} {...props} />;
};

/** Going live, in one tap: the organisation's Go live page, relative to the organisation layout it is under. */
export const AppBarGoLive: FC = () => {
  return (
    <NavLink
      to="live"
      aria-label="Go live"
      className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'size-9')}
    >
      <RecordIcon />
    </NavLink>
  );
};

/**
 * The account, at the bar's end: a menu of this browser's pins, the account's page and signing out, which the rail
 * holds as icons on a wider screen.
 */
export const AppBarAccount: FC = () => {
  const signOut = useSignOutOfStudio();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon" className="ml-auto size-9" aria-label="Account" />}
      >
        <UserCircleIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        {/* The pins are this browser's own, read from storage: there at once, with nothing to wait for. */}
        <Suspense>
          <AppBarPins />
        </Suspense>
        <DropdownMenuGroup>
          <DropdownMenuItem render={<Link to="/account" />}>
            <UserCircleGearIcon />
            Your account
          </DropdownMenuItem>
          <DropdownMenuItem disabled={signOut.pending} onClick={signOut.signOut}>
            <SignOutIcon />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** The pages pinned on this browser, under their own heading; nothing at all while there are none. */
const AppBarPins: FC = () => {
  const pinsQuery = useSuspenseQuery(pinListQueryOptions());
  if (pinsQuery.data.length === 0) return null;
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel>Pinned</DropdownMenuLabel>
        {pinsQuery.data.map(pin => (
          <DropdownMenuItem key={pin.to} render={<Link to={pin.to} />}>
            <PinIcon kind={pin.kind} />
            <span className="truncate">{pin.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
    </>
  );
};
