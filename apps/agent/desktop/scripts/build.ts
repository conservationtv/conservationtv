import { rm } from 'node:fs/promises';
import { build as esbuild } from 'esbuild';
import { build as vite } from 'vite';
import { mainBundle, preloadBundle } from './bundles.ts';

// Everything electron-builder packages, under dist/: the main process, the preload, and the renderer.
await rm('dist', { recursive: true, force: true });
await Promise.all([esbuild(mainBundle), esbuild(preloadBundle), vite({ configFile: 'vite.config.ts' })]);
