// What the runner works out for the review tool besides signing off: reports, uploaded beside the signoffs' results
// under `<commit>/<name>/`, that give no commit status and fail only when they cannot be made. Browser-safe: the
// review tool lists them; src/cli.ts makes them.

export interface Report {
  name: string;
  label: string;
  /** What it holds. */
  meaning: string;
}

export const reports: readonly Report[] = [
  {
    name: 'calls',
    label: 'Calls',
    meaning:
      "The functions the pull request changed and every use of them, as TypeScript's language server resolves them."
  }
];
