import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The webview is bundled as a single-page app with relative asset URLs so the
 * extension can serve it from `webview.asWebviewUri` without rewriting paths.
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  server: { port: 5173, strictPort: true },
});
