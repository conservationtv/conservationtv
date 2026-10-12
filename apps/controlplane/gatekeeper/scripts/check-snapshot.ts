import { snapshotStatus } from './snapshot-status.ts';

// Gate: success means matching. Predicate: success means a snapshot is required. Errors are distinct from either.
try {
  // Validate the mode, read the comparison once, then invert success only for the drift predicate.
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--required')) {
    throw new Error('Usage: check-snapshot.ts [--required]');
  }
  const status = snapshotStatus();
  console.log(JSON.stringify(status));
  const success = args[0] === '--required' ? status.required : !status.required;
  process.exitCode = success ? 0 : 1;
} catch (error) {
  console.error(error);
  process.exitCode = 2;
}
