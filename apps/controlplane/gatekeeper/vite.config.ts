import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [cloudflare()],
  // Clear of the studio's web app (5173) and API (5175), which registers this exchange URL as its audience.
  server: { port: 5176 }
});
