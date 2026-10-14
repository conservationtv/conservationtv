import { createContext, useContext } from 'react';

// Split out of components/theme-provider.tsx so that file exports only its component, which Fast Refresh needs.

export type Theme = 'dark' | 'light' | 'system';

/** Where ThemeProvider keeps the choice; the root route's pre-paint script reads the same key. */
export const THEME_STORAGE_KEY = 'theme';

/**
 * Runs in <head> before the first paint, so the page never shows the wrong theme while the app loads: the stored
 * choice, or the system's when it's `system` or unset, as the `light`/`dark` class ThemeProvider maintains afterwards.
 */
export const themeScript = `(() => {
  try {
    let theme = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    if (theme !== 'light' && theme !== 'dark') {
      theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.classList.add(theme);
    document.documentElement.style.colorScheme = theme;
  } catch {}
})();`;

export interface ThemeProviderState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

export const ThemeProviderContext = createContext<ThemeProviderState | undefined>(undefined);

/** The current theme preference and a setter; use inside ThemeProvider. */
export function useTheme(): ThemeProviderState {
  const context = useContext(ThemeProviderContext);
  if (context === undefined) throw new Error('useTheme must be used within a ThemeProvider');
  return context;
}
