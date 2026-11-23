// `pnpm dev`: makes sure .dev.vars reads GitHub with a token before starting the Worker. Anonymously GitHub allows 60
// requests an hour, a few pull requests' worth. When GITHUB_TOKEN is empty, or was filled here before, it is set from
// the GitHub CLI's own sign-in (`gh auth token`), afresh each time; a token set by hand is left alone.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const FILE = '.dev.vars';
const MARK = '# GITHUB_TOKEN below is `gh auth token`, refreshed by `pnpm dev`; set your own to keep it.';

const text = readFileSync(existsSync(FILE) ? FILE : '.dev.vars.example', 'utf8');
const lines = text.split('\n');
const at = lines.findIndex(line => line.startsWith('GITHUB_TOKEN='));
const ours = at > 0 && lines[at - 1] === MARK;
if (at >= 0 && (ours || lines[at] === 'GITHUB_TOKEN=')) {
  const gh = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  if (gh.status === 0 && gh.stdout.trim()) {
    lines[at] = `GITHUB_TOKEN=${gh.stdout.trim()}`;
    if (!ours) lines.splice(at, 0, MARK);
    writeFileSync(FILE, lines.join('\n'), { mode: 0o600 });
  } else {
    console.warn('GitHub CLI is not signed in (gh auth login): reading GitHub anonymously, 60 requests an hour.');
  }
}

const dev = spawnSync('cf', ['dev', ...process.argv.slice(2)], { stdio: 'inherit' });
process.exitCode = dev.status ?? 1;
