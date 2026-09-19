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
      // A user's own claude / codex, when the API keys page copies this origin into
      // ANTHROPIC_BASE_URL. Without these, Vite serves the SPA for GET /v1/models and
      // 404s POST /v1/messages, which Claude Code reports as "the selected model may not exist".
      '/v1': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
        configure(proxy) {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            }
          });
        },
      },
      '/u': { target: 'http://127.0.0.1:8788', changeOrigin: true, timeout: 0, proxyTimeout: 0 },
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
