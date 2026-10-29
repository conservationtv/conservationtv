import type { ReactNode, FC } from 'react';
import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from 'react-router';
import { MotionConfig } from 'motion/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { Spinner } from '@conservationtv/ui/components/spinner';
import { TooltipProvider } from '@conservationtv/ui/components/tooltip';

import '@conservationtv/ui/globals.css';
import type { Route } from './+types/root';
import { Panel } from '@/components/common/panel';
import { ThemeProvider } from '@/components/app/theme-provider';
import { THEME_STORAGE_KEY, themeScript } from '@/hooks/use-theme';
import { queryClient } from '@/lib/query-client';
import { apiQueries } from '@/queries/api';

/**
 * Negotiate the SDK's operation versions before any route loads data. This is middleware rather than the root's
 * clientLoader because a route chain's loaders run in parallel, while middleware finishes before any of them starts.
 * Queries and mutations only run after the first navigation, so nothing else needs to wait for it.
 */
export const clientMiddleware: Route.ClientMiddlewareFunction[] = [
  async (_args, next) => {
    await queryClient.query({ ...apiQueries.handshake(), staleTime: 'static' });
    await next();
  }
];

export const meta: Route.MetaFunction = () => [{ title: 'conservation.tv studio' }];

/** The logo's mark in its gradient, as rendered into public/ for browser tabs, home screens and installed apps. */
export const links: Route.LinksFunction = () => [
  { rel: 'icon', href: '/favicon.ico', sizes: '32x32' },
  { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
  { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
  { rel: 'manifest', href: '/site.webmanifest' }
];

export interface LayoutProps {
  children: ReactNode;
}

/** The document. It is rendered at build time into index.html, so it must not read browser-only state. */
export const Layout: FC<LayoutProps> = ({ children }) => {
  return (
    // The pre-paint script sets the theme class before React hydrates, so the attributes are expected to differ.
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        {/* The deployment's runtime configuration (src/lib/config.ts). A classic script, so it runs before the app's
            modules, which are deferred. */}
        <script src="/config.js" />
        <Meta />
        <Links />
      </head>
      {/* At least the screen's height: the body's background paints the whole window but is sized to the page, so on a
          page shorter than the screen the gradient would start over below it. */}
      <body className="min-h-svh bg-linear-to-b from-custom-canvas-top to-custom-canvas-bottom">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
};

/** The app in the browser: the providers read local storage and media queries, so they live here, not in Layout. */
const App: FC = () => {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider storageKey={THEME_STORAGE_KEY}>
        <TooltipProvider>
          {/* Animations drop their movement for anyone who has asked their system for reduced motion. */}
          <MotionConfig reducedMotion="user">
            <Outlet />
          </MotionConfig>
        </TooltipProvider>
      </ThemeProvider>
      {/*<ReactQueryDevtools buttonPosition="bottom-right" />*/}
    </QueryClientProvider>
  );
};

export default App;

/** Shown from index.html until the app has loaded and the first route's clientLoader has finished. */
export const HydrateFallback: FC = () => {
  return (
    // On the app's warm canvas, like the sign-in screens it usually hands over to.
    <main className="flex min-h-svh items-center justify-center bg-linear-to-b from-custom-canvas-top to-custom-canvas-bottom">
      <Spinner className="size-6 text-muted-foreground" />
    </main>
  );
};

export const ErrorBoundary: FC<Route.ErrorBoundaryProps> = ({ error }) => {
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : 'Unexpected error';
  return <Panel title="Something went wrong" description={message} />;
};
