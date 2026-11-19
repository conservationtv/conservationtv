// Builds the CLI as npm publishes it: dist/index.js, the CLI and every workspace package it uses bundled into one
// file, and dist/package.json, which names only what stays external. iroh stays external for its native addons, which
// npm installs per platform; iroh-http-node too, because it must load the same addon as the CLI's own iroh.
// `npm publish ./dist` publishes it (.github/workflows/release.yml).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const own = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8'));
const require = createRequire(import.meta.url);
const external = ['@number0/iroh', '@strangecyan/iroh-http-node'];

/** Each external as installed: `@number0/iroh` is an alias, so it is published as one (`npm:<name>@<version>`). */
function dependencyOf(name) {
  const installed = require(`${name}/package.json`);
  return installed.name === name ? installed.version : `npm:${installed.name}@${installed.version}`;
}

rmSync(new URL('dist', import.meta.url), { recursive: true, force: true });
mkdirSync(new URL('dist', import.meta.url));
await build({
  entryPoints: ['src/index.ts'],
  absWorkingDir: fileURLToPath(new URL('.', import.meta.url)),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external,
  // Bundled CommonJS calls require; an ES module has none, so give it one. Aliased, as the bundle imports
  // createRequire itself.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);"
  },
  outfile: 'dist/index.js',
  logLevel: 'warning'
});

const published = {
  name: own.name,
  version: own.version,
  description: own.description,
  type: 'module',
  bin: { ctv: 'index.js' },
  engines: own.engines,
  repository: own.repository,
  dependencies: Object.fromEntries(external.map(name => [name, dependencyOf(name)]))
};
writeFileSync(new URL('dist/package.json', import.meta.url), `${JSON.stringify(published, null, 2)}\n`);
console.log(`Built ${own.name}@${own.version} in dist/.`);
