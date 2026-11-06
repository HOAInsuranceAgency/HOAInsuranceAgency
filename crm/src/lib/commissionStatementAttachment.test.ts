import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ action: vi.fn(), upload: vi.fn() }));
vi.mock('./commissions', () => ({ commissionAction: h.action }));
import { attachCommissionStatement } from './commissionStatementAttachment';
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal('fetch', h.upload); });
afterEach(() => vi.unstubAllGlobals());

it('returns private evidence only after the conditional upload completes', async () => {
  const file = new File(['Policy,Amount\nPOL-1,600'], 'sample.csv');
  h.action.mockResolvedValue({ key: 'private/test-evidence', url: 'https://upload.example.test/statement' });
  let finish!: (value: { ok: boolean }) => void;
  h.upload.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  let completed = false;
  const pending = attachCommissionStatement(file).then(value => { completed = true; return value; });
  await vi.waitFor(() => expect(h.upload).toHaveBeenCalled());
  expect(completed).toBe(false);
  expect(h.action).toHaveBeenCalledWith('file', { action: 'upload', size: file.size, contentType: 'text/csv', filename: 'sample.csv' });
  expect(h.upload).toHaveBeenCalledWith('https://upload.example.test/statement', { method: 'PUT', headers: { 'Content-Type': 'text/csv', 'If-None-Match': '*' }, body: file });
  finish({ ok: true });
  await expect(pending).resolves.toEqual({ key: 'private/test-evidence', uploaded: true });
});
it('never exposes an evidence key after an upload failure', async () => {
  h.action.mockResolvedValue({ key: 'private/test-evidence', url: 'https://upload.example.test/statement' });
  h.upload.mockResolvedValue({ ok: false });
  await expect(attachCommissionStatement(new File(['test'], 'sample.csv'))).rejects.toThrow('Statement upload failed.');
});
it('does not transmit file content when authorization is denied', async () => {
  const denial = Object.assign(new Error('Access inactive'), { name: 'Unauthorized' });
  h.action.mockRejectedValue(denial);
  await expect(attachCommissionStatement(new File(['test'], 'sample.csv'))).rejects.toBe(denial);
  expect(h.upload).not.toHaveBeenCalled();
});
