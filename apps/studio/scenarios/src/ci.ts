import { mergeCommand } from './capture/combine.ts';
import { summaryCommand } from './capture/summary.ts';

// What CI's last job runs, with no packages installed: `node src/ci.ts merge|summary …`, on Node's own TypeScript.
// Everything it imports must use only Node's built-ins and erasable TypeScript.

const [name, ...rest] = process.argv.slice(2);
if (name === 'merge') mergeCommand(rest);
else if (name === 'summary') summaryCommand(rest);
else {
  console.error('Usage: node src/ci.ts merge --out <dir> <report dir>... | summary <report dir> [--url <index.html>]');
  process.exit(1);
}
