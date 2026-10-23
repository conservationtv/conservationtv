import { bindings, defineConfig } from 'cf/config';
import * as entrypoint from './src/worker/index.ts' with { type: 'cf-worker' };

export default defineConfig({
  worker: {
    name: 'review',
    compatibilityDate: '2026-09-25',
    compatibilityFlags: ['nodejs_compat'],
    entrypoint,
    domains: ['review.tools.conservation.tv'],
    // The React app is a single page: every path that is not an asset or the API serves index.html.
    assets: { notFoundHandling: 'single-page-application', runWorkerFirst: ['/api/*'] },
    env: {
      /** The repository whose pull requests are reviewed, as `owner/name`. */
      GITHUB_REPOSITORY: bindings.text('conservationtv/conservationtv'),
      /**
       * A fine-grained token with read access to public repositories only, so GitHub's rate limit is the token's own
       * 5,000 requests an hour, not 60 shared by every Worker on the same egress address. Everything read is public;
       * an empty token reads anonymously. See .dev.vars.example.
       */
      GITHUB_TOKEN: bindings.secret()
    }
  }
});
