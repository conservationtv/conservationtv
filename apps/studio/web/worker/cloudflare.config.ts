import { bindings, defineConfig } from 'cf/config';
import { z } from 'zod';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

// The Worker name and the runtime configuration for uploaded versions come from the studio Pulumi stack
// (../../infrastructure): set STACK_OUTPUT_JSON to its `pulumi stack output --json` when uploading. The build itself is
// the same for every stack; only these text bindings differ, and the Worker serves them as /config.js.
const StackOutputsSchema = z.object({
  web: z.object({
    workerName: z.string(),
    apiUrl: z.url()
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
    // The app's build. index.html is the pre-rendered homepage, so the Worker answers every other page with the plain
    // shell, __spa-fallback.html, instead of the assets' own single-page fallback, and any other missing file with a 404;
    // it serves /config.js too.
    assets: {
      notFoundHandling: 'none',
      runWorkerFirst: ['/config.js']
    },
    env: {
      /** The app's build, for the shell the Worker answers unknown paths with. */
      ASSETS: bindings.assets(),
      /** The studio API, which the app calls with credentials. */
      API_URL: bindings.text(stack?.apiUrl ?? process.env.API_URL ?? 'http://localhost:6421')
    }
  }
});
