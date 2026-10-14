import type { FC } from 'react';
import { ColumnsIcon, HouseIcon, SidebarIcon, TrayIcon, UserCircleIcon } from '@phosphor-icons/react';
import { NavLink, Outlet } from 'react-router';

const navigation = [
  { to: '/', label: 'App', icon: HouseIcon },
  { to: '/sidebar-07', label: 'Icons preview', icon: ColumnsIcon },
  { to: '/sidebar-09', label: 'Inbox preview', icon: TrayIcon },
  { to: '/sidebar-16', label: 'Header preview', icon: SidebarIcon },
  { to: '/account', label: 'Account', icon: UserCircleIcon }
];

export const AppLayout: FC = () => {
  return (
    <div className="flex h-dvh overflow-hidden bg-linear-to-b from-custom-canvas-top to-custom-canvas-bottom py-1.5 pr-1.5">
      <aside className="flex min-h-0 w-12 shrink-0 flex-col overflow-y-auto px-2 py-2">
        <nav aria-label="Main navigation" className="flex flex-col gap-2">
          {navigation.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end
              aria-label={label}
              title={label}
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground hover:bg-interaction-hover focus-visible:outline-2 focus-visible:outline-ring aria-[current=page]:bg-interaction-active"
            >
              <Icon className="size-4" aria-hidden="true" />
            </NavLink>
          ))}
        </nav>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg bg-background border-border border shadow-[0_0_12px_0_var(--custom-surface-shadow)]">
        {/* Route pages fill this pane and own their scrolling regions. */}
        <Outlet />
      </main>
    </div>
  );
};
