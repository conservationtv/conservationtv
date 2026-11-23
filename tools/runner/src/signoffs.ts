// The checks a pull request is signed off with. Each runs on a developer's machine (src/cli.ts), uploads what it wrote
// to the review tool, and is then given by `gh signoff` as a commit status, `signoff/<name>`, on the commit it ran at:
// a push needs signing off again. The review tool reads this list to show which are given and which are still to run.
// Browser-safe: the review tool's app imports it.

export interface Signoff {
  /** `gh signoff`'s name for it; its commit status is `signoff/<name>`. */
  name: string;
  label: string;
  /** The shell commands it runs, in order, from the repository's root. Any failing fails the signoff. */
  commands: readonly string[];
  /** What a signoff vouches for. */
  meaning: string;
}

export const signoffs: readonly Signoff[] = [
  { name: 'lint', label: 'Lint', commands: ['pnpm lint'], meaning: 'oxlint passes.' },
  {
    name: 'typecheck',
    label: 'Typecheck',
    commands: ['pnpm -r --no-bail typecheck'],
    meaning: 'Every package typechecks.'
  },
  {
    name: 'generated',
    label: 'Generated code',
    commands: [
      "pnpm -r --filter './apps/agent/**' --filter './apps/studio/**' --filter './apps/controlplane/**' run generate"
    ],
    meaning:
      'Every API document, SDK and CLI was regenerated at this commit and nothing changed: the generated files are what their generators write.'
  },
  {
    name: 'test',
    label: 'Tests',
    // The control plane's end-to-end tests need Docker and the relay images: they are run on their own.
    commands: ["pnpm -r --no-bail --filter '!@conservationtv/controlplane-tests' test"],
    meaning: "Every package's unit tests pass."
  },
  {
    name: 'contracts',
    label: 'API contracts',
    // The comparison only warns, for the review to weigh; a released snapshot edited in place fails.
    commands: ['pnpm contracts', 'pnpm contracts:snapshots'],
    meaning: 'Each API document was compared with the merge base, and no contract snapshot already released was edited.'
  }
];

/** A signoff's commit status context. */
export function signoffContext(signoff: Signoff): string {
  return `signoff/${signoff.name}`;
}

export const GENERATED_SIGNOFF = 'signoff/generated';
