import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Optional: point the dev proxy at a non-default backend (e.g. DMTL_API_ORIGIN=
// http://localhost:3001) so DMTool runs side-by-side with obsidian-web, which owns :3000.
const http = process.env.DMTL_API_ORIGIN || 'http://localhost:3001';
const ws   = process.env.DMTL_API_ORIGIN ? process.env.DMTL_API_ORIGIN.replace(/^http/, 'ws') : 'ws://localhost:3001';

export default defineConfig({
  plugins: [react()],
  base: '/dmtool/',
  server: {
    proxy: {
      '/dmtool/api': { target: http, rewrite: (p) => p.replace(/^\/dmtool/, '') },
      '/dmtool/ws':  { target: ws,  ws: true, rewrite: (p) => p.replace(/^\/dmtool/, '') },
    },
  },
});
