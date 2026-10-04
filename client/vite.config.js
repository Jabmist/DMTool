import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Optional: point the dev proxy at a non-default backend (e.g. DMTL_API_ORIGIN=
// http://localhost:3042) so two instances can run side-by-side on one box.
const http = process.env.DMTL_API_ORIGIN || 'http://localhost:3000';
const ws   = process.env.DMTL_API_ORIGIN ? process.env.DMTL_API_ORIGIN.replace(/^http/, 'ws') : 'ws://localhost:3000';

export default defineConfig({
  plugins: [react()],
  base: '/notes/',
  server: {
    proxy: {
      '/notes/api': { target: http, rewrite: (p) => p.replace(/^\/notes/, '') },
      '/notes/ws':  { target: ws,  ws: true, rewrite: (p) => p.replace(/^\/notes/, '') },
    },
  },
});
