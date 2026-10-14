import type { FC } from 'react';
import { MoonIcon, SunIcon } from '@phosphor-icons/react';
import { NavLink } from 'react-router';

import { Button } from '@conservationtv/ui/components/button';
import { buttonVariants } from '@conservationtv/ui/lib/button-variants';
import { cn } from '@conservationtv/ui/lib/utils';
import { useTheme } from '@/hooks/use-theme';

const previews = [
  { to: '/', label: 'App', title: 'App layout' },
  {
    to: '/sidebar-07',
    label: 'Icons',
    title: 'Sidebar 07: collapses to icons'
  },
  { to: '/sidebar-09', label: 'Inbox', title: 'Sidebar 09: nested sidebars' },
  {
    to: '/sidebar-16',
    label: 'Header',
    title: 'Sidebar 16: sticky site header'
  }
];

export const PreviewControls: FC = () => {
  const { theme, setTheme } = useTheme();

  function toggleTheme() {
    const isDark =
      theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    setTheme(isDark ? 'light' : 'dark');
  }

  return (
    <div className="ml-auto flex shrink-0 items-center gap-2">
      <nav aria-label="Sidebar previews" className="flex items-center gap-1">
        {previews.map(preview => (
          <NavLink
            key={preview.to}
            to={preview.to}
            end
            title={preview.title}
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'sm' }),
              'text-muted-foreground aria-[current=page]:bg-interaction-active aria-[current=page]:text-accent-foreground aria-[current=page]:hover:bg-interaction-active'
            )}
          >
            {preview.label}
          </NavLink>
        ))}
      </nav>
      <Button
        size="icon"
        variant="outline"
        onClick={toggleTheme}
        aria-label="Toggle light and dark mode"
        title="Toggle light and dark mode (D)"
      >
        <MoonIcon className="dark:hidden" />
        <SunIcon className="hidden dark:block" />
      </Button>
    </div>
  );
};
