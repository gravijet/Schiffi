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
      /**
       * Two documents, not one.
       *
       * console.html is the superadmin console. It is built here so it gets
       * the same tooling as everything else, but nothing in index.html links
       * to it and the server refuses to serve it as a static file - it is
       * handed out by routes/superadmin.js, to one account.
       */
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        console: resolve(import.meta.dirname, 'console.html'),
      },
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
