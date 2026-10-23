import type { WorkerInitializationRenderOptions, WorkerPoolOptions } from '@pierre/diffs/react';
// The portable worker bundles its own highlighter, so it never runs a second, unoptimized copy of Shiki's packages.
import HighlightWorker from '@pierre/diffs/worker/worker-portable.js?worker';

export const theme = { light: 'pierre-light', dark: 'pierre-dark' } as const;

/** Highlighting runs in a pool of Web Workers, so a pull request of thousands of lines never blocks scrolling. */
export const poolOptions: WorkerPoolOptions = {
  workerFactory: () => new HighlightWorker(),
  poolSize: Math.min(4, Math.max(1, navigator.hardwareConcurrency - 1))
};

export const highlighterOptions: WorkerInitializationRenderOptions = {
  theme,
  langs: ['typescript', 'tsx', 'javascript', 'json', 'sql', 'yaml', 'markdown', 'rust', 'toml', 'shellscript']
};
