import type { Config } from '@react-router/dev/config';

// Framework mode as a single-page app: the studio API is a separate Worker, so there is no server here. The build
// pre-renders the homepage, which reads nothing from the API as it renders, into build/client/index.html, and the
// root's HydrateFallback into build/client/__spa-fallback.html, which the Worker serves for every other page.
export default {
  appDirectory: 'src',
  ssr: false,
  prerender: ['/']
} satisfies Config;
