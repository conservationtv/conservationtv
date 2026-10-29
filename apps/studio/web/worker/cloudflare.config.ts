import { bindings, defineConfig } from 'cf/config';
import { z } from 'zod';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

// The Worker name and the runtime configuration for uploaded versions come from the studio Pulumi stack
// (../../infrastructure): set STACK_OUTPUT_JSON to its `pulumi stack output --json` when uploading. The build itself is
// the same for every stack; only these text bindings differ, and the Worker serves them as /config.js.
const StackOutputsSchema = z.object({
  web: z.object({
    workerName: z.string(),
    apiUrl: z.url(),
    // Checked in full by the app (SentryConfigSchema in ../src/lib/config.ts); absent while the stack sets no DSN.
    sentry: z
      .object({
        dsn: z.url(),
        environment: z.string(),
        tracesSampleRate: z.number(),
        replaysOnErrorSampleRate: z.number()
      })
      .optional()
  })
});
type StackOutputs = z.output<typeof StackOutputsSchema>;
const stack: StackOutputs['web'] | undefined = process.env.STACK_OUTPUT_JSON
  ? StackOutputsSchema.parse(JSON.parse(process.env.STACK_OUTPUT_JSON)).web
  : undefined;

export default defineConfig({
  worker: {
    /** Each stack's own Worker: `studio-web` for prod, `studio-web-<stack>` otherwise. */
    name: stack?.workerName ?? 'studio-web',
    compatibilityDate: '2026-09-25',
    entrypoint,
    // The app's build, with every unknown path answered by index.html. Only /config.js reaches the Worker.
    assets: {
      notFoundHandling: 'single-page-application',
      runWorkerFirst: ['/config.js']
    },
    env: {
      /** The studio API, which the app calls with credentials. */
      API_URL: bindings.text(stack?.apiUrl ?? process.env.API_URL ?? 'http://localhost:5175'),
      /** Where the app reports errors and traces, or null to report nothing. */
      SENTRY: bindings.json(stack?.sentry ?? null)
    }
  }
});
