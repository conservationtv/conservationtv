import type { BuildOptions } from 'esbuild';

// The main process and the preload, as esbuild builds them for both `build` and `dev`. The renderer is Vite's
// (vite.config.ts).

const shared: BuildOptions = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  logLevel: 'info'
};

/**
 * The main process, with the agent's core bundled into it. iroh stays external for its native addon, as in the
 * runner's bundle, and is the app's one runtime dependency; Electron is the host's own.
 */
export const mainBundle: BuildOptions = {
  ...shared,
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist/main/index.js',
  format: 'esm',
  external: ['electron', '@number0/iroh'],
  // Some of the core's dependencies require() Node's built-ins, which an ES module has no require for.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }
};

/** The preload: CommonJS, which a sandboxed renderer's preload must be. */
export const preloadBundle: BuildOptions = {
  ...shared,
  entryPoints: ['src/preload/index.ts'],
  outfile: 'dist/preload/index.cjs',
  format: 'cjs',
  external: ['electron']
};
