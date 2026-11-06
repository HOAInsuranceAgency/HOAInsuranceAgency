import { describe, expect, it, vi } from 'vitest';
import { createCompleteReadBudget, readCompleteModels, readCompleteRows } from '../../amplify/functions/communications/completeReads';

const message = 'The complete communication read could not be verified';

describe('communication complete-read budgets', () => {
  it('returns every row at the team page limit, including an empty filtered page', async () => {
    let page = 0;
    const fetch = vi.fn(async () => {
      const current = page++;
      return { items: current === 0 ? [] : Array.from({ length: 100 }, (_, index) => ({ id: `${current}:${index}` })),
        nextToken: current < 19 ? `page-${current + 1}` : undefined };
    });
    const rows = await readCompleteRows(fetch, 'team', message);
    expect(fetch).toHaveBeenCalledTimes(20);
    expect(rows).toHaveLength(1900);
    expect(rows[0]).toEqual({ id: '1:0' });
    expect(rows.at(-1)).toEqual({ id: '19:99' });
  });

  it('rejects an oversized team response instead of returning its first records', async () => {
    const fetch = vi.fn(async () => ({ items: Array.from({ length: 2001 }, (_, id) => ({ id })) }));
    await expect(readCompleteRows(fetch, 'team', message)).rejects.toThrow(message);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds accumulated bytes independently of the row count', async () => {
    const value = 'x'.repeat(220_000);
    const fetch = vi.fn(async () => ({ items: Array.from({ length: 40 }, () => ({ value })) }));
    await expect(readCompleteRows(fetch, 'team', message)).rejects.toThrow(message);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses malformed page data instead of treating it as an empty result', async () => {
    const fetch = vi.fn(async () => ({ data: undefined } as never));
    await expect(readCompleteModels(fetch, 'relations', message)).rejects.toThrow(message);
  });

  it('does not return partial model data when a later page reports errors', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ data: [{ id: 'first' }], nextToken: 'next' })
      .mockResolvedValueOnce({ data: [{ id: 'untrusted' }], errors: [{ message: 'Access revoked' }] });
    await expect(readCompleteModels(fetch, 'relations', message)).rejects.toThrow(message);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['Unauthorized', 'ThrottlingException'])('preserves a thrown %s error and adds no command retries', async name => {
    const error = Object.assign(new Error('The original read failed'), { name });
    const fetch = vi.fn().mockRejectedValue(error);
    await expect(readCompleteModels(fetch, 'relations', message)).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['rows', 'bytes'] as const)('retains the shared %s budget across separate model collections', async dimension => {
    const budget = createCompleteReadBudget();
    budget.rows = dimension === 'rows' ? 9_999 : 0;
    budget.bytes = dimension === 'bytes' ? 32 * 1024 * 1024 - 3 : 0;
    const first = vi.fn(async () => ({ data: dimension === 'rows' ? [{ id: 'last-permitted' }] : [] }));
    const second = vi.fn(async () => ({ data: [{ id: 'over-budget' }] }));
    const options = { budget, error: (message: string) => Object.assign(new Error(message), { code: 'CONTEXT_NOT_COMPLETE' }) };
    await expect(readCompleteModels(first, 'relations', message, options)).resolves.toHaveLength(dimension === 'rows' ? 1 : 0);
    await expect(readCompleteModels(second, 'relations', message, options)).rejects.toMatchObject({ message, code: 'CONTEXT_NOT_COMPLETE' });
    expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1);
  });
});
