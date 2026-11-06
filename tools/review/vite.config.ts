import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // React Compiler through the native (Rust, `oxc-transform-react`) compiler, as the studio's web app uses it.
  plugins: [react({ compiler: true }), cloudflare()],
  // Clear of the studio's web app (6420), API (6421) and gatekeeper (6422).
  server: { port: 6423 },
  // Syntax highlighting runs in Web Workers, which Vite bundles as ES modules.
  worker: { format: 'es' }
});
