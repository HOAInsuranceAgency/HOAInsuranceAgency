import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const local = (name: string) => fileURLToPath(new URL(name, import.meta.url));
export default defineConfig({
  root: local('.'), publicDir: local('../../public'), plugins: [react()],
  resolve: { alias: [
    { find: 'aws-amplify/data', replacement: local('./data.ts') },
    { find: 'aws-amplify/storage', replacement: local('./storage.ts') },
    { find: /^(\.\.\/)+lib\/communications$/, replacement: local('./communications.ts') },
    { find: /^\.\/communications$/, replacement: local('./communications.ts') },
  ] },
  server: { host: '127.0.0.1', port: 8769, fs: { allow: [local('../../..')] } },
});
