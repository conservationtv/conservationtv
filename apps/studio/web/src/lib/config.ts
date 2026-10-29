import { z } from 'zod';

declare global {
  /** Set by /config.js, which the document loads before any module; see worker/index.ts. */
  var studioConfig: unknown;
}

const StudioConfigSchema = z.object({
  /** The studio API. Its cookies are same-site, so credentials travel with every call. */
  apiUrl: z.url()
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
