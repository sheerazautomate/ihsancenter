import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The SPA calls the API at /api/* on its own origin. In development Vite proxies
 * that to `wrangler dev`, so the browser never talks cross-origin and cookies
 * behave exactly as they will in production (where Pages proxies to the Worker).
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // The Arena preview is served from a proxied host, so the dev server must
    // accept it rather than only localhost.
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
});
