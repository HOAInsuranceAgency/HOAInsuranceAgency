import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const root = fileURLToPath(new URL('../', import.meta.url));
const mock = resolve(root, 'scripts/commercial-preview/fixtures.ts');
const result = await build({
  entryPoints: [resolve(root, 'scripts/commercial-preview/main.tsx')],
  bundle: true,
  write: false,
  outdir: '/tmp/hoa-commercial-preview',
  format: 'iife',
  minify: true,
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    {
      name: 'fictional-workspace',
      setup(b) {
        b.onResolve(
          {
            filter:
              /^(?:(?:\.\.\/)+lib\/(?:communications|client)|\.\/(?:communications|client))$/,
          },
          () => ({ path: mock }),
        );
      },
    },
  ],
});
const css = result.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';
const js = result.outputFiles.find((f) => f.path.endsWith('.js'))?.text ?? '';
if (!js) throw new Error('Preview did not compile');
const target = resolve(root, '../docs/LEAD-TABLES-PACKAGES-PREVIEW.html');
await mkdir(resolve(root, '../docs'), { recursive: true });
await writeFile(
  target,
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lead tables and quote packages — review workspace</title><style>${css.replace(/<\/style/gi, '<\\/style')}</style></head><body><div id="root"></div><script>${js.replace(/<\/script/gi, '<\\/script')}</script></body></html>`,
);
console.log(`Created ${target}`);
