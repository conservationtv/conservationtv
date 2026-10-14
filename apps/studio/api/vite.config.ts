import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

// 5175 keeps clear of the studio web app's Vite dev server. Vite's own CORS handling is off: it would answer
// preflights for any localhost origin without `Access-Control-Allow-Credentials`, hiding the Worker's CORS policy.
export default defineConfig({
  plugins: [cloudflare()],
  server: { port: 5175, cors: false }
});
