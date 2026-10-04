import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/notes/',
  server: {
    proxy: {
      '/notes/api': { target: 'http://localhost:3000', rewrite: (p) => p.replace(/^\/notes/, '') },
      '/notes/ws':  { target: 'ws://localhost:3000',  ws: true, rewrite: (p) => p.replace(/^\/notes/, '') },
    },
  },
});
