import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  invoiceList: vi.fn(), loanList: vi.fn(), request: vi.fn(), assignments: vi.fn(), forbidden: vi.fn(),
}));
vi.mock('./client', async () => ({
  listAllPages: (await import('./pagination')).listAllPages,
  client: { models: {
    Invoice: { list: h.invoiceList }, PfLoan: { list: h.loanList },
    PfLoanPayment: { list: h.forbidden }, Policy: { list: h.forbidden },
    InvoiceLine: { list: h.forbidden }, Account: { list: h.forbidden },
  } },
}));
vi.mock('./communications', () => ({ communicationRequest: h.request }));
vi.mock('./dashboardAssignments', () => ({ loadAssignments: h.assignments }));
import { loadFinanceDashboard, loadFinancePolicyAnchors, loadRecentFinanceInterest } from './dashboardFinanceLoad';

beforeEach(() => {
  for (const mock of Object.values(h)) mock.mockReset();
  h.forbidden.mockRejectedValue(new Error('Whole-history/table read is forbidden'));
  h.invoiceList.mockResolvedValue({ data: [] });
  h.loanList.mockResolvedValue({ data: [] });
  h.assignments.mockResolvedValue({ entries: {}, team: [], accounts: [] });
});

it('uses a fixed indexed window across pages, including paid/removed-loan receipts', async () => {
  const asOf = new Date('2026-09-30T16:00:00.000Z');
  const receipt = { id: 'old-loan-payment', accountId: 'a', postedAt: asOf.toISOString(), interest: 6 };
  h.request.mockResolvedValueOnce({ items: [receipt], nextToken: 'page-2' }).mockResolvedValueOnce({ items: [receipt] });
  expect(await loadRecentFinanceInterest(asOf)).toEqual([receipt]);
  expect(h.request.mock.calls).toEqual([
    ['dashboardInterestPage', { from: '2026-08-31T16:00:00.000Z', to: '2026-09-30T16:00:00.000Z' }],
    ['dashboardInterestPage', { from: '2026-08-31T16:00:00.000Z', to: '2026-09-30T16:00:00.000Z', nextToken: 'page-2' }],
  ]);
  expect(h.forbidden).not.toHaveBeenCalled();
});

it('fails a broken/repeating page instead of showing partial income', async () => {
  h.request.mockResolvedValue({ items: [], nextToken: 'same-page' });
  await expect(loadRecentFinanceInterest(new Date())).rejects.toThrow('did not advance');
  h.request.mockReset().mockResolvedValueOnce({ items: [], nextToken: 'next' }).mockRejectedValueOnce(new Error('Read failed'));
  await expect(loadRecentFinanceInterest(new Date())).rejects.toThrow('Read failed');
});

it('reads line relations only for open invoices on outstanding-loan accounts and fetches referenced policy anchors', async () => {
  const relatedLines = vi.fn().mockResolvedValueOnce({ data: [{ invoiceId: 'relevant', policyId: 'line-policy' }], nextToken: 'lines-2' })
    .mockResolvedValueOnce({ data: [{ invoiceId: 'relevant', policyId: 'line-policy-2' }] });
  const unrelatedLines = vi.fn().mockRejectedValue(new Error('Unrelated lines must not load'));
  h.invoiceList.mockResolvedValue({ data: [
    { id: 'relevant', accountId: 'a', policyId: 'invoice-policy', status: 'SENT', lines: relatedLines },
    { id: 'unrelated', accountId: 'b', status: 'PROCESSING', lines: unrelatedLines },
    { id: 'history', accountId: 'a', status: 'PAID', lines: unrelatedLines },
  ] });
  h.loanList.mockResolvedValue({ data: [
    { id: 'live', accountId: 'a', policyId: 'loan-policy', status: 'ACTIVE', balance: 100 },
    { id: 'offer', accountId: 'c', policyId: 'offer-policy', status: 'QUOTED', balance: 100 },
  ] });
  h.request.mockImplementation(async (operation, input) => operation === 'dashboardInterestPage'
    ? { items: [{ id: 'orphan-receipt', accountId: 'd', interest: 7, postedAt: input.to }] }
    : { items: input.policyIds.map((id: string) => ({ id, accountId: 'a', quoteId: `quote-${id}` })), missingIds: [] });
  h.assignments.mockResolvedValue({ entries: {}, team: [], accounts: [{ id: 'a', name: 'Account A' }] });
  const result = await loadFinanceDashboard();
  expect(relatedLines.mock.calls).toEqual([[{ nextToken: undefined }], [{ nextToken: 'lines-2' }]]);
  expect(unrelatedLines).not.toHaveBeenCalled();
  expect(h.request.mock.calls.find(([operation]) => operation === 'dashboardPolicyAnchors')?.[1].policyIds)
    .toEqual(['loan-policy', 'invoice-policy', 'line-policy', 'line-policy-2']);
  expect(h.assignments).toHaveBeenCalledWith(['a', 'b', 'd']);
  expect(result.accounts).toEqual([{ id: 'a', name: 'Account A' }]);
  expect(result.invoiceLines).toHaveLength(2);
  expect(h.forbidden).not.toHaveBeenCalled();
  expect(h.invoiceList).toHaveBeenCalledWith(expect.objectContaining({ filter: { or: [{ status: { eq: 'SENT' } }, { status: { eq: 'PROCESSING' } }] } }));
});

it('deduplicates and bounds policy batches without dropping later pages', async () => {
  h.request.mockImplementation(async (_operation, input) => ({
    items: input.policyIds.filter((id: string) => id !== 'p-250').map((id: string) => ({ id, accountId: 'a' })),
    missingIds: input.policyIds.includes('p-250') ? ['p-250'] : [],
  }));
  const ids = Array.from({ length: 251 }, (_, n) => `p-${n}`);
  expect(await loadFinancePolicyAnchors([...ids, ids[0]])).toHaveLength(250);
  expect(h.request.mock.calls.map(([, input]) => input.policyIds.length)).toEqual([100, 100, 51]);
  h.request.mockResolvedValue({ items: [], missingIds: [] });
  await expect(loadFinancePolicyAnchors(['p'])).rejects.toThrow('incomplete');
});
