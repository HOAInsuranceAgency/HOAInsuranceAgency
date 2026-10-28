import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { appendEntry } from '../../../shared/commissions';
import { commissionPolicy, line, statement } from '../test/commissionFixtures';
const h = vi.hoisted(() => ({
  owner: false,
  read: vi.fn(),
  action: vi.fn(),
  policies: vi.fn(),
}));
vi.mock('../lib/auth', () => ({ useIsOwner: () => h.owner }));
vi.mock('../lib/commissions', () => ({ readCommissions: h.read, commissionAction: h.action }));
vi.mock('../lib/client', () => ({
  client: { models: { Policy: { list: h.policies } } },
  listAllPages: async () => [],
  fmtMoney: (n: number) => `$${n.toFixed(2)}`,
  friendlyError: (e: Error) => e.message,
}));
vi.mock('../lib/communications', () => ({ communicationRequest: async () => ({ team: [] }) }));
vi.mock('../components/ReportDownload', () => ({ ReportDownload: () => null }));
import Commissions from './Commissions';
const snapshot = () => ({
  plans: [],
  carriers: [],
  policies: [appendEntry(commissionPolicy(), line(), statement(), 'e')],
  statements: [{ ...statement(), lines: [line()] }],
  batches: [],
});
beforeEach(() => {
  vi.resetAllMocks();
  h.owner = false;
  h.read.mockResolvedValue(snapshot());
  h.action.mockResolvedValue({ ok: true });
});
it('shows producer earnings without any reconciliation or payroll controls', async () => {
  render(<Commissions />);
  await screen.findByText('Producer earned');
  expect(screen.queryByRole('tab', { name: 'Reconciliation' })).toBeNull();
  expect(screen.queryByRole('tab', { name: 'Payroll' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'New reconciliation' })).toBeNull();
  expect(h.action).not.toHaveBeenCalled();
});
it('allows the Owner to review and post only after explicit settlement confirmation', async () => {
  h.owner = true;
  render(<Commissions />);
  await screen.findByText('Producer earned');
  fireEvent.click(screen.getByRole('tab', { name: 'Reconciliation' }));
  expect(screen.getByRole('button', { name: 'Post reconciled statement' })).toBeDisabled();
  expect(h.action).not.toHaveBeenCalled();
  h.action.mockClear();
  fireEvent.click(screen.getByLabelText(/I verified settlement evidence/));
  fireEvent.click(screen.getByRole('button', { name: 'Post reconciled statement' }));
  await waitFor(() =>
    expect(h.action).toHaveBeenCalledWith('postStatement', {
      id: 's',
      version: 1,
      confirmed: true,
    }),
  );
});
it('unmounts owner forms and clears old data immediately when switching roles', async () => {
  h.owner = true;
  const view = render(<Commissions />);
  await screen.findByText('Producer earned');
  fireEvent.click(screen.getByRole('tab', { name: 'Reconciliation' }));
  expect(screen.getByText('OCT-1')).toBeVisible();
  let finish!: (v: unknown) => void;
  h.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  h.owner = false;
  view.rerender(<Commissions />);
  expect(screen.queryByText('OCT-1')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Post reconciled statement' })).toBeNull();
  await act(async () => finish({ policies: [], batches: [] }));
  expect(screen.queryByText('OCT-1')).toBeNull();
});
it('clears all financial data after a failed refresh', async () => {
  render(<Commissions />);
  await screen.findByText('Producer earned');
  h.read.mockRejectedValueOnce(new Error('Access inactive'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh commissions' }));
  await screen.findByRole('alert');
  expect(screen.queryByText('Producer earned')).toBeNull();
});

it('searches historical policies in filtered pages and follows empty continuation pages', async () => {
  h.owner = true;
  h.policies.mockResolvedValueOnce({ data: [], nextToken: 'page-2' }).mockResolvedValueOnce({
    data: [{ id: 'legacy', policyNumber: 'OLD-1' }],
    nextToken: null,
  });
  render(<Commissions />);
  await screen.findByText('Producer earned');
  fireEvent.click(screen.getByRole('tab', { name: 'Agreements & carriers' }));
  const search = await screen.findByLabelText('Find historical policy number');
  expect(h.policies).not.toHaveBeenCalled();
  fireEvent.change(search, { target: { value: 'OLD' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search historical policies' }));
  const next = await screen.findByRole('button', { name: 'Next policies' });
  expect(h.policies).toHaveBeenCalledExactlyOnceWith({
    filter: {
      and: [
        { commissionSnapshotId: { attributeExists: false } },
        { policyNumber: { contains: 'OLD' } },
      ],
    },
    limit: 25,
    nextToken: undefined,
  });
  fireEvent.click(next);
  await screen.findByRole('option', { name: /OLD-1/ });
  expect(h.policies.mock.calls[1][0]).toMatchObject({ limit: 25, nextToken: 'page-2' });
  expect(h.policies).toHaveBeenCalledTimes(2);
});
