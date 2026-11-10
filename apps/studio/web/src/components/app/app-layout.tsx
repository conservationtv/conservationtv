import { Suspense, type ComponentProps, type FC } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { PushPinSimpleIcon, SignOutIcon, UserCircleGearIcon } from '@phosphor-icons/react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { Spinner } from '@conservationtv/ui/components/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@conservationtv/ui/components/tooltip';
import { cn } from '@conservationtv/ui/lib/utils';

import { PinIcon } from '@/components/app/pins';
import { BrandMark } from '@/components/brand/brand-mark';
import { appHomePath } from '@/lib/route-guards';
import { useSignOut } from '@/queries/session';
import { pinListQueryOptions } from '@/queries/this-device';

const railItemClassName =
  'flex size-8 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground hover:bg-interaction-hover focus-visible:outline-2 focus-visible:outline-ring aria-[current=page]:bg-interaction-active [&_svg]:size-4';

/**
 * The app: a narrow rail down the left (home, the pages pinned on this browser, the account and signing out) beside
 * the pane every page under it renders in.
 */
export const AppLayout: FC = () => {
  return (
    <div className="flex h-dvh overflow-hidden bg-linear-to-b from-custom-canvas-top to-custom-canvas-bottom py-1.5 pr-1.5">
      <aside className="flex min-h-0 w-12 shrink-0 flex-col overflow-y-auto px-2 py-2">
        <nav aria-label="Main navigation" className="flex flex-1 flex-col items-center gap-3">
          <Tooltip>
            <TooltipTrigger render={<NavLink to={appHomePath} end className={railItemClassName} />}>
              <BrandMark className="h-auto w-6" />
              <span className="sr-only">Home</span>
            </TooltipTrigger>
            <TooltipContent side="right">Home</TooltipContent>
          </Tooltip>
          {/* The pins are this browser's own, read from storage: there at once, with nothing to wait for. */}
          <Suspense>
            <RailPins />
          </Suspense>
          <div className="mt-auto flex flex-col gap-0.5">
            <Tooltip>
              <TooltipTrigger render={<NavLink to="/account" className={railItemClassName} />}>
                <UserCircleGearIcon aria-hidden="true" />
                <span className="sr-only">Your account</span>
              </TooltipTrigger>
              <TooltipContent side="right">Your account</TooltipContent>
            </Tooltip>
            <SignOutButton className={railItemClassName} />
          </div>
        </nav>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-background shadow-[0_0_12px_0_var(--custom-surface-shadow)]">
        {/* Route pages fill this pane and own their scrolling regions. The rail stays while they load. */}
        <Suspense fallback={<Spinner className="m-auto size-6 text-muted-foreground" />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
};

/** The pages pinned on this browser, under a pin that says what they are; nothing at all while there are none. */
const RailPins: FC = () => {
  const pinsQuery = useSuspenseQuery(pinListQueryOptions());
  if (pinsQuery.data.length === 0) return null;
  return (
    <div className="flex flex-col items-center gap-0.5">
      <PushPinSimpleIcon weight="fill" className="mb-1.5 size-3 text-custom-icon-pin" aria-hidden="true" />
      {pinsQuery.data.map(pin => (
        <Tooltip key={pin.to}>
          <TooltipTrigger render={<NavLink to={pin.to} className={railItemClassName} />}>
            <PinIcon kind={pin.kind} />
            <span className="sr-only">{pin.label}</span>
          </TooltipTrigger>
          <TooltipContent side="right">{pin.label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
};

/** Signs out, then leaves for the sign-in page: everything under the app needs a session. */
const SignOutButton: FC<ComponentProps<'button'>> = ({ className, ...props }) => {
  const navigate = useNavigate();
  const signOut = useSignOut();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(className, signOut.isPending && 'opacity-50')}
            disabled={signOut.isPending}
            onClick={() => signOut.mutate(undefined, { onSuccess: () => navigate('/sign-in', { replace: true }) })}
            {...props}
          />
        }
      >
        <SignOutIcon aria-hidden="true" />
        <span className="sr-only">Sign out</span>
      </TooltipTrigger>
      <TooltipContent side="right">Sign out</TooltipContent>
    </Tooltip>
  );
};
