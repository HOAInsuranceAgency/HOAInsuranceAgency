// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ config: vi.fn(), configure: vi.fn(), generate: vi.fn() }));
vi.mock('@aws-amplify/backend/function/runtime', () => ({ getAmplifyDataClientConfig: m.config }));
vi.mock('aws-amplify', () => ({ Amplify: { configure: m.configure } }));
vi.mock('aws-amplify/data', () => ({ generateClient: m.generate }));
import { createDataClientGetter } from '../../amplify/functions/data-client';

const config = { resourceConfig: { fixture: 'resource' }, libraryOptions: { fixture: 'library' } };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetAllMocks();
  m.config.mockResolvedValue(config);
  m.generate.mockReturnValue({ models: {} });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('per-consumer Lambda data clients', () => {
  it('does no initialization until the first read, then caches the successful client', async () => {
    const getClient = createDataClientGetter();
    expect(m.config).not.toHaveBeenCalled();
    expect(m.configure).not.toHaveBeenCalled();
    expect(m.generate).not.toHaveBeenCalled();
    const order: string[] = [], client = { models: { fixture: true } };
    m.config.mockImplementation(async () => { order.push('config'); return config; });
    m.configure.mockImplementation(() => { order.push('configure'); });
    m.generate.mockImplementation(() => { order.push('generate'); return client; });
    expect(await getClient()).toBe(client);
    expect(await getClient()).toBe(client);
    expect(order).toEqual(['config', 'configure', 'generate']);
    expect(m.configure).toHaveBeenCalledExactlyOnceWith(config.resourceConfig, config.libraryOptions);
  });

  it('reads the invocation environment lazily rather than snapshotting it at factory creation', async () => {
    const getClient = createDataClientGetter();
    vi.stubEnv('HOA_TEST_CLIENT_INIT_MARKER', 'set-after-creation');
    const observed: string[] = [];
    m.config.mockImplementation(async env => { observed.push(env.HOA_TEST_CLIENT_INIT_MARKER); return config; });
    await getClient();
    expect(observed).toEqual(['set-after-creation']);
  });

  it.each(['config', 'configure', 'generate'] as const)('retries a failed %s only when the caller asks again', async stage => {
    const getClient = createDataClientGetter(), error = new Error(`Failed ${stage}`);
    if (stage === 'config') m.config.mockRejectedValueOnce(error);
    else m[stage].mockImplementationOnce(() => { throw error; });
    await expect(getClient()).rejects.toBe(error);
    expect(m.config).toHaveBeenCalledOnce();
    const client = await getClient();
    expect(await getClient()).toBe(client);
    expect(m.config).toHaveBeenCalledTimes(2);
  });

  it('keeps independent successful caches for different consumers', async () => {
    const first = createDataClientGetter(), second = createDataClientGetter();
    const a = { models: { consumer: 'a' } }, b = { models: { consumer: 'b' } };
    m.generate.mockReturnValueOnce(a).mockReturnValueOnce(b);
    expect(await first()).toBe(a);
    expect(await second()).toBe(b);
    expect(await first()).toBe(a);
    expect(await second()).toBe(b);
    expect(m.config).toHaveBeenCalledTimes(2);
  });

  it('preserves independent concurrent cold calls and caches the last completed initialization', async () => {
    const firstConfig = deferred<typeof config>(), secondConfig = deferred<typeof config>();
    m.config.mockReturnValueOnce(firstConfig.promise).mockReturnValueOnce(secondConfig.promise);
    const getClient = createDataClientGetter(), first = getClient(), second = getClient();
    expect(m.config).toHaveBeenCalledTimes(2);
    const a = { models: { consumer: 'first' } }, b = { models: { consumer: 'second' } };
    m.generate.mockReturnValueOnce(b).mockReturnValueOnce(a);
    secondConfig.resolve(config);
    expect(await second).toBe(b);
    firstConfig.resolve(config);
    expect(await first).toBe(a);
    expect(await getClient()).toBe(a);
    expect(m.generate).toHaveBeenCalledTimes(2);
  });

  it('does not clear a completed client when another concurrent cold call fails', async () => {
    const pending = deferred<typeof config>();
    m.config.mockReturnValueOnce(pending.promise);
    const getClient = createDataClientGetter(), failed = getClient();
    const client = await getClient();
    const rejection = expect(failed).rejects.toThrow('Configuration unavailable');
    pending.reject(new Error('Configuration unavailable'));
    await rejection;
    expect(await getClient()).toBe(client);
    expect(m.config).toHaveBeenCalledTimes(2);
  });
});

it('keeps runtime data configuration owned by the server factory', () => {
  const root = fileURLToPath(new URL('../../amplify/functions/', import.meta.url));
  function files(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
      ? files(join(directory, entry.name)) : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : []);
  }
  const owners = files(root).filter(path => {
    const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    return file.statements.some(node => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text === '@aws-amplify/backend/function/runtime'
      && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
      && node.importClause.namedBindings.elements.some(item => (item.propertyName ?? item.name).text === 'getAmplifyDataClientConfig'));
  });
  expect(owners).toEqual([join(root, 'data-client.ts')]);
});
