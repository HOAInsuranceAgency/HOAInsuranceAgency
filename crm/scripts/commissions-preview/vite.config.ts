import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const fixture = fileURLToPath(new URL('./fixtures.ts', import.meta.url));
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: fileURLToPath(new URL('../../public', import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^(\.\.\/)+lib\/(client|auth|commissions|communications)$/, replacement: fixture },
      { find: /^\.\/(client|auth|commissions|communications)$/, replacement: fixture },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 8791,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL('../../..', import.meta.url))] },
  },
});
