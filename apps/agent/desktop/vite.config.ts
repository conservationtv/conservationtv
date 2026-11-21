import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The renderer: one page, served by Vite in development and loaded from dist/renderer/ when packaged, so its assets
// are addressed relative to it.
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  base: './',
  plugins: [tailwindcss(), react()],
  // Beside the studio's dev servers (6420 up, apps/studio/web/vite.config.ts), on a port of its own.
  server: { port: 6430, strictPort: true },
  build: { outDir: resolve(import.meta.dirname, 'dist/renderer'), emptyOutDir: true }
});
