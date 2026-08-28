import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Matched before /api below — Vite tries the keys in the order they are written, and
      // this is the one /api path the gateway owns rather than the application. Same split
      // as the handle blocks in docker/Caddyfile, so dev and a deployment answer alike.
      '/api/oauth': { target: 'http://127.0.0.1:8788', changeOrigin: true },
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        // SSE needs buffering off
        configure(proxy) {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            }
          });
        },
      },
    },
  },
});
