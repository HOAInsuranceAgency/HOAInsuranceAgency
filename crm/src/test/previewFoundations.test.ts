// @vitest-environment node
import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createPreviewConfig, previewResolver } from '../../scripts/preview-support/config';

const configUrl = new URL('../../scripts/commercial-preview/vite.config.ts', import.meta.url).href;
const path = (relative: string) => fileURLToPath(new URL(relative, configUrl));
const resolvePreview = () => previewResolver(configUrl, { port: 8768, modules: ['client', 'communications'] });

it('replaces the exact source module from any feature depth without matching a similar module name', () => {
  const resolve = resolvePreview(), fixture = path('./fixtures.ts');
  expect(resolve('../lib/client', path('../../src/components/QuotePackages.tsx'))).toBe(fixture);
  expect(resolve('../../lib/client.ts', path('../../src/features/invoicing/useInvoiceEditor.ts'))).toBe(fixture);
  expect(resolve('./communications', path('../../src/lib/commercial.ts'))).toBe(fixture);
  expect(resolve('/@fs/' + path('../../src/lib/client.ts'), path('./main.tsx'))).toBe(fixture);
  expect(resolve('../../lib/clientHelpers', path('../../src/features/example/view.tsx'))).toBeUndefined();
  expect(resolve('../../lib/auth', path('../../src/features/example/view.tsx'))).toContain('preview-support/auth.ts');
});

it('rejects real provider SDKs and requires a declared fictional client and Front replacement', () => {
  const resolve = resolvePreview();
  for (const name of ['aws-amplify/auth', 'aws-amplify/data', '@aws-sdk/client-s3', '@aws-amplify/ui-react', '@frontapp/plugin-sdk']) {
    expect(() => resolve(name, path('./main.tsx'))).toThrow('real provider SDK');
  }
  const noClient = previewResolver(configUrl, { port: 8768, modules: [] });
  expect(() => noClient('../../lib/client', path('../../src/features/example/view.tsx'))).toThrow('explicit fictional client');
  const front = previewResolver(configUrl, { port: 8768, modules: ['client'], frontSdk: true });
  expect(front('@frontapp/plugin-sdk')).toBe(path('./fixtures.ts'));
});

it('preserves explicit component replacements, local binding, public assets and port behavior', () => {
  const replacement = new URL('./FilePreview.tsx', configUrl);
  const options = { port: 8768, modules: ['client'] as const, publicDir: false, strictPort: false,
    replacements: { 'src/components/FilePreview': replacement } };
  expect(previewResolver(configUrl, options)('./FilePreview', path('../../src/components/DocumentsPanel.tsx'))).toBe(fileURLToPath(replacement));
  const config = createPreviewConfig(configUrl, options);
  expect(config.root).toBe(path('./'));
  expect(config.server).toMatchObject({ host: '127.0.0.1', port: 8768, strictPort: false });
  expect(config.publicDir).toBe(false);
  expect(createPreviewConfig(configUrl, { port: 8786, modules: ['client'] }).publicDir).toBe(path('../../public'));
  expect(() => createPreviewConfig(configUrl, { port: 0, modules: [] })).toThrow('valid local preview port');
});

