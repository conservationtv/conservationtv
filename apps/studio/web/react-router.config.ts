import type { Config } from '@react-router/dev/config';

// Framework mode as a single-page app: the studio API is a separate Worker, so there is no server here. The build
// pre-renders the root's HydrateFallback into build/client/index.html; every route loads data with clientLoader.
export default {
  appDirectory: 'src',
  ssr: false
} satisfies Config;
