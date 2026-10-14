// `api-contracts <command>`, run from an API's directory (the one holding contracts.config.ts).
import { parseArgs } from 'node:util';
import { loadProject } from './config.js';
import { checkRelease, checkSnapshot, ci, snapshot } from './commands.js';
import { generateBundle } from './openapi.js';

const usage = `Usage: api-contracts <command> [options]

  generate                       Write openapi.json from the routes and their handler types.
  snapshot <tag>                 Regenerate, then freeze the bundle as snapshots/<tag>.json.
  check-release [--base <ref>] [--tag <tag>]
                                 Frozen snapshots are unchanged and no released contract differs.
  check-snapshot [--required]    Exit 0 when the bundle matches the latest snapshot (or, with --required, when it doesn't).
  ci <pr|main|release|snapshots> The CI gates; reads API_BASE_REF, API_RELEASE_TAG, GITHUB_ACTIONS and GITHUB_STEP_SUMMARY.

  --config <file>                The contracts config. Defaults to ./contracts.config.ts.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string' },
    base: { type: 'string' },
    tag: { type: 'string' },
    required: { type: 'boolean', default: false }
  }
});
const [command, argument] = positionals;

try {
  const project = await loadProject(values.config);
  // One case per command; anything else prints the usage and fails.
  switch (command) {
    case 'generate':
      await generateBundle(project);
      break;
    case 'snapshot':
      await snapshot(project, argument);
      break;
    case 'check-release':
      checkRelease(project, { base: values.base, tag: values.tag });
      break;
    case 'check-snapshot':
      process.exitCode = checkSnapshot(project, values.required);
      break;
    case 'ci':
      ci(project, argument, {
        baseRef: process.env.API_BASE_REF,
        releaseTag: process.env.API_RELEASE_TAG,
        githubActions: process.env.GITHUB_ACTIONS === 'true',
        stepSummary: process.env.GITHUB_STEP_SUMMARY
      });
      break;
    default:
      throw new Error(usage);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  // check-snapshot distinguishes a failed predicate (1) from an error (2); every other command fails with 1.
  process.exitCode = command === 'check-snapshot' ? 2 : 1;
}
