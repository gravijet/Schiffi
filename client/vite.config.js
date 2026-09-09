import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * Build configuration.
 *
 * Performance is a requirement, not a nicety, so the build is set up for it:
 * the shared game data is split out of the entry chunk (it is large and
 * cacheable), the locale files are split per language so a player downloads
 * one, and the API/WebSocket are proxied in development so the client never
 * needs a CORS path.
 */
export default defineConfig({
  root: resolve(import.meta.dirname),
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: true,
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/i18n/locales/')) {
            const match = /locales\/([\w-]+)\.js/.exec(id);
            if (match && match[1] !== 'index') return `locale-${match[1]}`;
          }
          if (id.includes('/shared/src/data/')) return 'gamedata';
          if (id.includes('/shared/src/')) return 'shared';
          return undefined;
        },
        // Hashed names so the server can cache them immutably.
        entryFileNames: 'assets/[name].[hash].js',
        chunkFileNames: 'assets/[name].[hash].js',
        assetFileNames: 'assets/[name].[hash][extname]',
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
});
