import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [cloudflare()],
  // Clear of the studio's web app (6420) and API (6421), which registers this exchange URL as its audience.
  server: { port: 6422 }
});
