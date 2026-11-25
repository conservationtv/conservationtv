// What the runner works out for the review tool besides signing off: reports, uploaded beside the signoffs' results
// under `<commit>/<name>/`, that give no commit status and fail only when they cannot be made. Browser-safe: the
// review tool lists them; src/cli.ts makes them.

export interface Report {
  name: string;
  label: string;
  /** What it holds. */
  meaning: string;
  /**
   * Path prefixes a change must touch for the report to be made when every report is asked for; named, it is made
   * regardless. Every change, when left out.
   */
  paths?: readonly string[];
}

export const reports: readonly Report[] = [
  {
    name: 'calls',
    label: 'Calls',
    meaning:
      "The functions the pull request changed and every use of them, as TypeScript's language server resolves them."
  },
  {
    name: 'scenarios',
    label: 'Screens',
    meaning:
      'The studio web app screenshotted across generated worlds at the merge base and the head, each shot compared.',
    // What the web app is built from: the paths .github/workflows/scenarios.yml watched.
    paths: [
      'apps/studio/web/',
      'apps/studio/sdk/',
      'apps/studio/api/contracts/',
      'apps/studio/api/src/health/',
      'apps/studio/scenarios/',
      'apps/agent/sdk/',
      'packages/versioned-api/',
      'packages/ui/',
      'packages/reports/',
      'packages/shows/',
      'packages/cameras/',
      'pnpm-lock.yaml'
    ]
  }
];
