import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

// The app is built by React Router (`react-router build`, into ../build/client); this only builds the Worker that
// serves it, taking that build as its static assets.
export default defineConfig({
  plugins: [cloudflare()],
  publicDir: '../build/client'
});
