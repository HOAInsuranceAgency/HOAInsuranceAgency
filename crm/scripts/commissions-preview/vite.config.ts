import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
const fixture = fileURLToPath(new URL('./fixtures.ts', import.meta.url));
const mockedModules = new Set(['client', 'auth', 'commissions', 'communications', 'commissionStatementAttachment'].map(name =>
  resolve(fileURLToPath(new URL('../../src/lib', import.meta.url)), name)));
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: fileURLToPath(new URL('../../public', import.meta.url)),
  plugins: [{
    name: 'commission-preview-boundaries',
    enforce: 'pre',
    resolveId(source, importer) {
      // Mock only the CRM's service boundaries. Shared calculation modules
      // also import ./commissions and must keep their real implementation.
      if (importer && source.startsWith('.') && mockedModules.has(resolve(dirname(importer.split('?')[0]), source).replace(/\.tsx?$/, ''))) return fixture;
      return null;
    },
  }, react(), {
    name: 'commission-sample-pdfs',
    generateBundle() {
      const catalog = JSON.parse(readFileSync(fileURLToPath(new URL('./report-samples.generated.json', import.meta.url)), 'utf8'));
      for (const file of catalog.documents) {
        if (!/^[A-Za-z0-9_.-]+\.pdf$/.test(file.filename)) throw new Error('Invalid sample PDF filename');
        this.emitFile({type:'asset',fileName:'reports/' + file.filename,source:Buffer.from(file.content,'base64')});
      }
    },
  }],
  server: {
    host: '127.0.0.1',
    port: 8791,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL('../../..', import.meta.url))] },
  },
});
