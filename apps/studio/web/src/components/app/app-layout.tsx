import type { FC } from 'react';
import { GearIcon, PushPinSimpleIcon, SignOutIcon, UserCircleGearIcon } from '@phosphor-icons/react';
import { NavLink, Outlet } from 'react-router';
import { Tooltip, TooltipContent, TooltipTrigger } from '@conservationtv/ui/components/tooltip';

export const AppLayout: FC = () => {
  return (
    <div className="flex h-dvh overflow-hidden bg-linear-to-b from-custom-canvas-top to-custom-canvas-bottom py-1.5 pr-1.5">
      <aside className="flex min-h-0 w-12 shrink-0 flex-col overflow-y-auto px-2 py-2">
        <nav aria-label="Main navigation" className="flex flex-1 flex-col gap-2">
          {/* Pushed to the bottom of the rail. */}
          <div className="flex flex-col gap-0.5 items-center">
            <PushPinSimpleIcon weight="fill" size={12} className="mb-2" />
            <Tooltip>
              <TooltipTrigger>
                <NavLink
                  to="/account"
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground hover:bg-interaction-hover focus-visible:outline-2 focus-visible:outline-ring aria-[current=page]:bg-interaction-active"
                >
                  <GearIcon className="size-4" aria-hidden="true" />
                </NavLink>
              </TooltipTrigger>
              <TooltipContent side="right">
                <div className="flex flex-col">
                  <span>Alveus Sanctuary</span>
                </div>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger>
                <NavLink
                  to="/account"
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground hover:bg-interaction-hover focus-visible:outline-2 focus-visible:outline-ring aria-[current=page]:bg-interaction-active"
                >
                  <GearIcon className="size-4" aria-hidden="true" />
                </NavLink>
              </TooltipTrigger>
              <TooltipContent side="right">Your settings</TooltipContent>
            </Tooltip>
          </div>
          <div className="mt-auto flex flex-col gap-0.5">
            <Tooltip>
              <TooltipTrigger>
                <NavLink
                  to="/account"
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground hover:bg-interaction-hover focus-visible:outline-2 focus-visible:outline-ring aria-[current=page]:bg-interaction-active"
                >
                  <UserCircleGearIcon className="size-4" aria-hidden="true" />
                </NavLink>
              </TooltipTrigger>
              <TooltipContent side="right">Your settings</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger>
                <NavLink
                  to="/account"
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground hover:bg-interaction-hover focus-visible:outline-2 focus-visible:outline-ring aria-[current=page]:bg-interaction-active"
                >
                  <SignOutIcon className="size-4" aria-hidden="true" />
                </NavLink>
              </TooltipTrigger>
              <TooltipContent side="right">Sign out</TooltipContent>
            </Tooltip>
          </div>
        </nav>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg bg-background border-border border shadow-[0_0_12px_0_var(--custom-surface-shadow)]">
        {/* Route pages fill this pane and own their scrolling regions. */}
        <Outlet />
      </main>
    </div>
  );
};
