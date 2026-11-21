import { type ChildProcess, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { context, type Plugin } from 'esbuild';
import { build, createServer } from 'vite';
import { mainBundle, preloadBundle } from './bundles.ts';
import { devApp } from './dev-app.ts';

// The app in development: the renderer from Vite's dev server, with hot reload, and the main process and preload
// rebuilt on change, restarting Electron.
//
// On macOS, Electron is a copy with the app's own identity, so ctvagent:// links reach it (dev-app.ts). A link can
// start it while this isn't running, without the dev server, so the renderer is built once too, for it to load.
// Elsewhere it is Electron's own, run on this folder through its package's CLI, which passes SIGTERM on to it.

/** The command that runs the app. */
async function electronCommand(): Promise<[string, string[]]> {
  if (process.platform === 'darwin') {
    await build({ configFile: 'vite.config.ts', logLevel: 'warn' });
    return [await devApp(), []];
  }
  const cli = createRequire(import.meta.url).resolve('electron/cli.js');
  return [process.execPath, [cli, '.']];
}

const [electronBinary, electronArgs] = await electronCommand();

const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
const rendererUrl = server.resolvedUrls?.local[0];
if (rendererUrl === undefined) throw new Error('The renderer dev server has no local URL');

let electron: ChildProcess | undefined = undefined;
let restarting = false;

/** Stop Electron gracefully, so the agent stops with it, and start it again. */
async function restart() {
  if (restarting) return;
  restarting = true;
  const running = electron;
  electron = undefined;
  if (running !== undefined && running.exitCode === null) {
    const exited = new Promise(resolve => running.once('exit', resolve));
    running.kill('SIGTERM');
    await exited;
  }
  const child = spawn(electronBinary, electronArgs, {
    stdio: 'inherit',
    env: { ...process.env, DESKTOP_RENDERER_URL: rendererUrl }
  });
  // Quitting the app ends development, unless this script is the one restarting it.
  child.once('exit', () => {
    if (electron === child) void shutdown();
  });
  electron = child;
  restarting = false;
}

async function shutdown() {
  await Promise.all([main.dispose(), preload.dispose(), server.close()]);
  process.exit(0);
}

/** Restarts Electron after each rebuild that succeeds. */
const restartOnBuild: Plugin = {
  name: 'restart-electron',
  setup(build) {
    build.onEnd(result => {
      if (result.errors.length === 0) void restart();
    });
  }
};

const preload = await context(preloadBundle);
await preload.rebuild();
await preload.watch();
const main = await context({ ...mainBundle, plugins: [restartOnBuild] });
await main.watch();

process.on('SIGINT', () => {
  electron?.kill('SIGTERM');
});
