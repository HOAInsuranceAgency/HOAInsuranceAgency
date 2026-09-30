import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures.ts', import.meta.url));
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: fileURLToPath(new URL('../../public', import.meta.url)),
  plugins: [react()],
  resolve: { alias: [
    { find: /^(\.\.\/)+lib\/(client|scopedStorage|storage|acord)$/, replacement: fixture },
    { find: /^\.\/(client|scopedStorage|storage|acord)$/, replacement: fixture },
    { find: /^\.\/FilePreview$/, replacement: fileURLToPath(new URL('./FilePreview.tsx', import.meta.url)) },
  ] },
  server: {
    host: '127.0.0.1', port: 8785, strictPort: true,
    fs: { allow: [fileURLToPath(new URL('../../..', import.meta.url))] },
  },
});
