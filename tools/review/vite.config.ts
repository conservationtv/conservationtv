import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // React Compiler through the native (Rust, `oxc-transform-react`) compiler, as the studio's web app uses it.
  plugins: [react({ compiler: true }), cloudflare()],
  // Clear of the studio's web app (5173), API (5175) and gatekeeper (5176).
  server: { port: 5177 },
  // Syntax highlighting runs in Web Workers, which Vite bundles as ES modules.
  worker: { format: 'es' }
});
