import { defineConfig, type UserConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type MockedModule = 'client' | 'communications' | 'auth' | 'commissions' | 'scopedStorage' | 'storage' | 'acord';
export interface PreviewOptions {
  port: number;
  modules: readonly MockedModule[];
  frontSdk?: boolean;
  publicDir?: boolean;
  strictPort?: boolean;
  /** Source-relative module paths to dedicated local replacements. */
  replacements?: Readonly<Record<string, URL>>;
}
const canonical = (value: string) => resolve(value).replace(/\.(?:tsx?|m?js)$/, '');

export function previewResolver(configUrl: string, options: PreviewOptions) {
  const root = fileURLToPath(new URL('../../', configUrl));
  const fixture = fileURLToPath(new URL('./fixtures.ts', configUrl));
  const replacements = new Map<string, string>(options.modules.map(name => [canonical(resolve(root, 'src/lib', name)), fixture]));
  if (!replacements.has(canonical(resolve(root, 'src/lib/auth'))))
    replacements.set(canonical(resolve(root, 'src/lib/auth')), fileURLToPath(new URL('./auth.ts', import.meta.url)));
  for (const [source, target] of Object.entries(options.replacements ?? {})) replacements.set(canonical(resolve(root, source)), fileURLToPath(target));
  const client = canonical(resolve(root, 'src/lib/client'));
  return (source: string, importer?: string): string | undefined => {
    if (source === '@frontapp/plugin-sdk' && options.frontSdk) return fixture;
    if (/^(?:aws-amplify(?:\/|$)|@aws-sdk\/|@aws-amplify\/|@frontapp\/plugin-sdk(?:\/|$))/.test(source))
      throw new Error(`Local previews cannot load a real provider SDK: ${source}`);
    const clean = source.split('?')[0].replace(/^\/@fs\//, '/');
    const resolved = isAbsolute(clean) ? canonical(clean) : clean.startsWith('.') && importer ? canonical(resolve(dirname(importer.split('?')[0]), clean)) : undefined;
    if (!resolved) return undefined;
    const replacement = replacements.get(resolved);
    if (replacement) return replacement;
    if (resolved === client) throw new Error('Declare an explicit fictional client for this preview.');
    return undefined;
  };
}

/** Local previews share build mechanics, while each declares its own APIs and role scenario. */
export function createPreviewConfig(configUrl: string, options: PreviewOptions): UserConfig {
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65_535) throw new Error('Choose a valid local preview port.');
  const resolvePreview = previewResolver(configUrl, options);
  return defineConfig({
    root: fileURLToPath(new URL('.', configUrl)),
    publicDir: options.publicDir === false ? false : fileURLToPath(new URL('../../public', configUrl)),
    plugins: [{ name: 'fictional-preview-boundaries', enforce: 'pre', resolveId: resolvePreview }, react()],
    server: { host: '127.0.0.1', port: options.port, strictPort: options.strictPort ?? true,
      fs: { allow: [fileURLToPath(new URL('../../..', configUrl))] } },
  });
}
