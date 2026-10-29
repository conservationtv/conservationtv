import {
  addIntegration,
  breadcrumbsIntegration,
  createSentryClientInstrumentation,
  init,
  reactRouterTracingIntegration,
  sentryOnError
} from '@sentry/react-router';
import type { HydratedRouterProps } from 'react-router/dom';

import { config } from './config';
import { hasTelemetryConsent } from './telemetry-consent';

/**
 * Matches URLs on `url`'s origin and nothing else: not a longer host that starts with it, and not the origin quoted in
 * another URL's query. tracePropagationTargets matches strings anywhere in a URL, hence a pattern.
 */
function originPattern(url: string): RegExp {
  const origin = new URL(url).origin;
  const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}(?:[/?#]|$)`);
}

/** Replay is most of the SDK's size, so only browsers that have consented to it download it. */
async function startReplay(): Promise<void> {
  const { replayIntegration } = await import('./sentry-replay');
  const replay = replayIntegration();
  addIntegration(replay);
}

/**
 * Starts reporting to the stack's Sentry project, if it has one, and returns what HydratedRouter needs to report its
 * errors and trace its navigations, loaders and middleware. Errors and traces need no consent; the UI telemetry that
 * records what someone does (DOM breadcrumbs, and replays of the sessions that hit an error) waits for it.
 *
 * Runs in the browser only, before hydration: entry.client.tsx is the one caller.
 */
export function startSentry(): Pick<HydratedRouterProps, 'instrumentations' | 'onError'> {
  const sentry = config.sentry;
  if (!sentry) return {};
  const consented = hasTelemetryConsent();
  init({
    dsn: sentry.dsn,
    environment: sentry.environment,
    // The release is injected at build time by the Sentry Vite plugin (vite.config.ts), with the source maps it uploads.
    sampleRate: 1,
    tracesSampleRate: sentry.tracesSampleRate,
    // The browser sends trace headers to the studio API only, which allows them in its CORS. The W3C `traceparent`
    // lets the API Worker's own tracing join the trace; `sentry-trace` and `baggage` go alongside it.
    tracePropagationTargets: [originPattern(config.apiUrl)],
    propagateTraceparent: true,
    // No IP addresses or user details, cookies, headers, bodies or query strings (the device page's carries its code).
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
    // Only an error starts a replay, and only with consent; see below.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: sentry.replaysOnErrorSampleRate,
    // Without consent, nothing that names what was clicked or typed into: no DOM breadcrumbs, and no interaction spans
    // (the INP web vital's, named by their target element).
    ignoreSpans: consented ? [] : [{ op: /^ui\.interaction\./ }],
    integrations: [reactRouterTracingIntegration(), breadcrumbsIntegration({ dom: consented })]
  });
  if (consented && sentry.replaysOnErrorSampleRate > 0) void startReplay();
  const instrumentation = createSentryClientInstrumentation();
  return { instrumentations: [instrumentation], onError: sentryOnError };
}
