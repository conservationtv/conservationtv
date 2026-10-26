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
      GITHUB_TOKEN: bindings.secret(),
      /**
       * A GitHub OAuth app's client ID and secret, for reviewers to sign in and comment, review and merge as themselves.
       * The app holds no permissions: each reviewer grants their own token. Its callback URL is
       * https://review.tools.conservation.tv/api/auth/callback. Empty, the tool only reads.
       */
      GITHUB_CLIENT_ID: bindings.secret(),
      GITHUB_CLIENT_SECRET: bindings.secret(),
      /** Seals the session cookie holding a reviewer's token: any long random string, such as `openssl rand -hex 32`. */
      SESSION_SECRET: bindings.secret()
    }
  }
});
