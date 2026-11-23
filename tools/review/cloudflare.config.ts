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
      /**
       * Signoff runs from developers' machines (tools/runner): each run's log, reports and result, under
       * `<commit>/<signoff>/`. Create it once with `pnpm exec cf r2 bucket create review-results`.
       */
      RESULTS: bindings.r2({ name: 'review-results' }),
      /** Grafana Cloud, whose traces show how each service did around a deploy. Empty, deploys show without them. */
      GRAFANA_URL: bindings.text('https://valiantlagoon729.grafana.net'),
      /** A Viewer service account's token for it (Administration → Service accounts). */
      GRAFANA_TOKEN: bindings.secret(),
      /**
       * A T3 scheduled task's webhook that starts an agent signing a pull request off (pnpm signoff, fixing what fails).
       * Its URL is its only credential, so it is a secret, and only the Worker calls it. Empty, no agent buttons show.
       */
      AGENT_HOOK_URL: bindings.secret(),
      /**
       * A T3 scheduled task's webhook that starts an agent fixing the code one comment points at, pushing the fix and
       * replying on its thread. A secret, like AGENT_HOOK_URL. Empty, no comment agent buttons show.
       */
      AGENT_COMMENT_HOOK_URL: bindings.secret(),
      /** Who may start agents, by GitHub login, comma-separated: they run on the owner's machine and push. */
      AGENT_OPERATORS: bindings.text('changesbyjames'),
      /** Seals the session cookie holding a reviewer's token: any long random string, such as `openssl rand -hex 32`. */
      SESSION_SECRET: bindings.secret()
    }
  }
});
