import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ get: vi.fn(), accountRows: vi.fn() }));
vi.mock('../../amplify/functions/communications/store', () => ({ get: h.get, audit: vi.fn(), check: vi.fn(), absent: vi.fn(), commit: vi.fn(), put: vi.fn(), row: vi.fn() }));
vi.mock('../../amplify/functions/communications/data', () => ({ dataClient: vi.fn() }));
vi.mock('../../amplify/functions/communications/workflow', () => ({ accountRows: h.accountRows }));
import { commercialTable } from '../../amplify/functions/communications/commercial';
beforeEach(() => { vi.clearAllMocks(); h.get.mockResolvedValue(null); });
it('loads actions only on request and returns the earliest open action, excluding completed work', async () => {
  await commercialTable(['account']); expect(h.accountRows).not.toHaveBeenCalled();
  h.accountRows.mockResolvedValue([
    { version: 2, data: { id: 'late', status: 'OPEN', dueAt: '2026-10-01' } },
    { version: 3, data: { id: 'closed', status: 'DONE', dueAt: '2026-09-01' } },
    { version: 4, data: { id: 'next', status: 'OPEN', dueAt: '2026-09-24' } },
  ]);
  const [result] = await commercialTable(['account'], true);
  expect(h.accountRows).toHaveBeenCalledWith('account', 'TASK');
  expect(result).toMatchObject({ accountId: 'account', actionCount: 2, nextAction: { id: 'next', version: 4 } });
});
it('distinguishes no open work from failure and bounds each request to one visible page', async () => {
  h.accountRows.mockResolvedValue([]);
  expect((await commercialTable(['a'], true))[0]).toMatchObject({ nextAction: null, actionCount: 0 });
  h.accountRows.mockRejectedValue(new Error('Task query unavailable'));
  await expect(commercialTable(['a'], true)).rejects.toThrow('Task query unavailable');
  await expect(commercialTable(Array.from({ length: 26 }, (_, i) => `a${i}`), true)).rejects.toThrow('25 accounts');
  await expect(commercialTable(['a','a'], true)).rejects.toThrow('25 accounts');
});
