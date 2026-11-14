// @vitest-environment node
import type { Context } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ getClient: vi.fn(), client: undefined as unknown }));
// Exercise the retained staging handler's existing client initialization; no real AWS calls.
vi.mock('aws-amplify', () => ({ Amplify: { configure: vi.fn() } }));
vi.mock('aws-amplify/data', () => ({ generateClient: () => h.client }));
vi.mock('@aws-amplify/backend/function/runtime', () => ({
  getAmplifyDataClientConfig: async () => { h.client = await h.getClient(); return { resourceConfig: {}, libraryOptions: {} }; },
}));
import type { handler as StageHandler } from '../../amplify/functions/form-filler/handler';
let handler: typeof StageHandler;

const field = 'Insured_FullName_A';
const event = { arguments: { accountId: 'synthetic-account', formKey: 'synthetic-form', fieldNames: [field] } } as Parameters<typeof handler>[0];
function context(remaining = 29_000) {
  const started = Date.now();
  return { getRemainingTimeInMillis: () => remaining - (Date.now() - started) } as Context;
}
function dataClient() {
  const list = () => vi.fn<(...args: unknown[]) => Promise<{ data: Record<string, unknown>[]; nextToken?: string | null }>>().mockResolvedValue({ data: [], nextToken: null });
  return { models: {
    Account: { get: vi.fn().mockResolvedValue({ data: { id: 'synthetic-account' } }) },
    Contact: { list: list() }, PriorCarrier: { list: list() }, Building: { list: list() },
    Blanket: { list: list() }, GlApplication: { list: list() }, GlClassCode: { list: list() },
    DoApplication: { list: list() }, DoCoveragePart: { list: list() }, Loss: { list: list() },
    Quote: { list: list() }, Policy: { list: list() },
  } };
}
function response() {
  return new Response(JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify({ fields: [{ field, value: 'Synthetic association', why: 'account.name' }] }) }],
    stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 0 },
  }), { headers: { 'content-type': 'application/json' } });
}
function pendingFetch(signal: AbortSignal) {
  return new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
}

beforeEach(async () => {
  vi.resetModules();
  handler = (await import('../../amplify/functions/form-filler/handler')).handler;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-14T00:00:00Z'));
  vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-test-key');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.getClient.mockReset().mockResolvedValue(dataClient());
});
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

describe('optional form-fill deadline with the real Anthropic SDK and mocked transport', () => {
  it('aborts a request before headers, returns the existing optional fallback, and never retries', async () => {
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => pendingFetch(init!.signal as AbortSignal));
    vi.stubGlobal('fetch', fetch);
    const pending = handler(event, context(), () => {});
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const signal = fetch.mock.calls[0][1]!.signal as AbortSignal;
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await pending).toMatchObject({ ok: false, values: [], error: expect.stringContaining('took too long') });
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('also aborts a stalled response body after headers have arrived', async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => new Response(new ReadableStream({
      start(body) { init!.signal!.addEventListener('abort', () => body.error(new DOMException('Aborted', 'AbortError')), { once: true }); },
    }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const pending = handler(event, context(8_000), () => {});
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toMatchObject({ ok: false, values: [], error: expect.stringContaining('took too long') });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a hanging data-client initialization and makes no provider call when it later settles', async () => {
    let complete!: (client: ReturnType<typeof dataClient>) => void;
    h.getClient.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const pending = handler(event, context(5_000), () => {});
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toMatchObject({ ok: false, values: [] });
    const client = dataClient(); complete(client);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.models.Account.get).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds an in-flight model read and prevents late pagination and provider calls', async () => {
    const client = dataClient(); let complete!: (page: { data: Record<string, unknown>[]; nextToken: string }) => void;
    client.models.Contact.list.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    h.getClient.mockResolvedValue(client);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const pending = handler(event, context(5_000), () => {});
    await vi.waitFor(() => expect(client.models.Contact.list).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toMatchObject({ ok: false, values: [] });
    complete({ data: [], nextToken: 'synthetic-next-page' });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.models.Contact.list).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds an account lookup and handles its late rejection without follow-up work', async () => {
    const client = dataClient(); let reject!: (error: Error) => void;
    client.models.Account.get.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    h.getClient.mockResolvedValue(client);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const pending = handler(event, context(5_000), () => {});
    await vi.waitFor(() => expect(client.models.Account.get).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toMatchObject({ ok: false, values: [] });
    reject(new Error('synthetic late read failure')); await vi.advanceTimersByTimeAsync(0);
    expect(client.models.Contact.list).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops late parallel pagination after another read fails before the deadline', async () => {
    const client = dataClient(); let complete!: (page: { data: Record<string, unknown>[]; nextToken: string }) => void;
    client.models.Contact.list.mockRejectedValue(new Error('synthetic read failure'));
    client.models.PriorCarrier.list.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    h.getClient.mockResolvedValue(client);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(await handler(event, context(), () => {})).toMatchObject({ ok: false, error: 'synthetic read failure', values: [] });
    complete({ data: [], nextToken: 'synthetic-next-page' }); await vi.advanceTimersByTimeAsync(0);
    expect(client.models.PriorCarrier.list).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start the provider if synchronous prompt construction consumes the budget', async () => {
    const client = dataClient();
    client.models.Account.get.mockResolvedValue({ data: { id: 'synthetic-account', metadata: {
      toJSON() { vi.setSystemTime(new Date('2026-11-14T00:00:10Z')); return 'synthetic value'; },
    } } } as never);
    h.getClient.mockResolvedValue(client);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(await handler(event, context(5_000), () => {})).toMatchObject({ ok: false, values: [] });
    expect(fetch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('uses only the remaining invocation budget after account reads', async () => {
    const client = dataClient();
    client.models.Account.get.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 4_000)); return { data: { id: 'synthetic-account' } }; });
    h.getClient.mockResolvedValue(client);
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => pendingFetch(init!.signal as AbortSignal)); vi.stubGlobal('fetch', fetch);
    let completedAt: number | undefined;
    const pending = Promise.resolve(handler(event, context(10_000), () => {})).then(result => { completedAt = Date.now(); return result; });
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await pending).toMatchObject({ ok: false, values: [] });
    expect(completedAt).toBe(new Date('2026-11-14T00:00:07Z').getTime());
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 2_999, 3_000, NaN, Infinity])('does not start any work with an exhausted or invalid remaining time %s', async remaining => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(await handler(event, context(remaining), () => {})).toMatchObject({ ok: false, values: [] });
    expect(h.getClient).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([429, 500])('does not retry a provider %s response', async status => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { type: 'synthetic_error', message: 'synthetic provider unavailable' } }), { status, headers: { 'content-type': 'application/json', 'retry-after': '60' } }));
    vi.stubGlobal('fetch', fetch);
    expect(await handler(event, context(), () => {})).toMatchObject({ ok: false, values: [] });
    expect(fetch).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry a connection failure', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('synthetic connection failure'); });
    vi.stubGlobal('fetch', fetch);
    expect(await handler(event, context(), () => {})).toMatchObject({ ok: false, values: [] });
    expect(fetch).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it('returns immediately without a provider request when no fields are blank', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(await handler({ ...event, arguments: { ...event.arguments, fieldNames: [] } }, context(), () => {})).toEqual({ ok: true, values: [], skipped: 0 });
    expect(h.getClient).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves successful sanitized suggestions and clears the deadline for the next warm invocation', async () => {
    const fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch);
    expect(await handler(event, context(), () => {})).toEqual({ ok: true, values: [{ field, value: 'Synthetic association', why: 'account.name' }], skipped: 0 });
    const signal = (fetch.mock.calls[0] as unknown as [unknown, RequestInit])[1].signal;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000); expect(signal?.aborted).toBe(false);
    expect(await handler(event, context(), () => {})).toMatchObject({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
});
