/**
 * The checks a pull request is signed off with, locally, by `gh signoff` (the root package.json's `signoff:*`
 * scripts). Each is a commit status on the head commit, so a push needs signing off again.
 */
export interface Signoff {
  context: string;
  label: string;
  script: string;
  /** What a signoff vouches for. */
  meaning: string;
}

export const signoffs: readonly Signoff[] = [
  { context: 'signoff/lint', label: 'Lint', script: 'pnpm signoff:lint', meaning: 'oxlint passes.' },
  {
    context: 'signoff/typecheck',
    label: 'Typecheck',
    script: 'pnpm signoff:typecheck',
    meaning: 'Every package typechecks.'
  },
  {
    context: 'signoff/generated',
    label: 'Generated code',
    script: 'pnpm signoff:generated',
    meaning:
      'Every API document, SDK and CLI was regenerated at this commit and nothing changed: the generated files are what their generators write.'
  }
];

export const GENERATED_SIGNOFF = 'signoff/generated';
