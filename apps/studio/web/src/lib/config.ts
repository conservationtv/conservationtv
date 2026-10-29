import { z } from 'zod';

declare global {
  /** Set by /config.js, which the document loads before any module; see worker/index.ts. */
  var studioConfig: unknown;
}

/** Where the app reports its errors and traces; see lib/sentry.ts. */
const SentryConfigSchema = z.object({
  /** The Sentry project's client key. It is public: it can only send events to that project. */
  dsn: z.url(),
  /** The stack the app is deployed as, e.g. `staging` or `prod`. */
  environment: z.string(),
  /** The share of page loads and navigations traced, and so of the API requests they make. */
  tracesSampleRate: z.number().min(0).max(1),
  /** The share of sessions that send a replay when they hit an error. Replays need telemetry consent. */
  replaysOnErrorSampleRate: z.number().min(0).max(1)
});
export type SentryConfig = z.output<typeof SentryConfigSchema>;

const StudioConfigSchema = z.object({
  /** The studio API. Its cookies are same-site, so credentials travel with every call. */
  apiUrl: z.url(),
  /** Absent where the stack sets no Sentry project, as in local development: nothing is reported. */
  sentry: SentryConfigSchema.optional()
});
export type StudioConfig = z.output<typeof StudioConfigSchema>;

/**
 * The deployment's runtime configuration. The build is the same for every environment: each one's Worker serves its
 * own /config.js, a classic script in the document's head, so it has always run before this module is evaluated.
 * Rendering index.html (at build time, and by the dev server) evaluates the app's modules in Node, where there is no
 * /config.js; nothing calls the API there, so it gets an address that cannot resolve.
 */
export const config: StudioConfig = import.meta.env.SSR
  ? { apiUrl: 'https://prerender.invalid' }
  : StudioConfigSchema.parse(globalThis.studioConfig);
