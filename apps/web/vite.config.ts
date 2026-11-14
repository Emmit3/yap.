import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    fs: {
      // Retain Vite's sensitive-file defaults when extending the deny list.
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/local-context/**', '**/data/**'],
    },
    proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true } },
  },
});
