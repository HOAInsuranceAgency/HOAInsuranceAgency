import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { appendEntry } from '../../../shared/commissions';
import { commissionPolicy, line, statement } from '../test/commissionFixtures';
const h = vi.hoisted(() => ({
  owner: false,
  read: vi.fn(),
  action: vi.fn(),
  policies: vi.fn(),
  communications: vi.fn(),
}));
vi.mock('../lib/auth', () => ({ useIsOwner: () => h.owner }));
vi.mock('../lib/commissions', () => ({
  readCommissions: h.read,
  commissionAction: h.action,
}));
vi.mock('../lib/client', () => ({
  client: { models: { Policy: { list: h.policies } } },
  listAllPages: async () => [],
  fmtMoney: (n: number) => `$${n.toFixed(2)}`,
  friendlyError: (e: Error) => e.message,
}));
vi.mock('../lib/communications', () => ({
  communicationRequest: h.communications,
}));
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
  h.communications.mockResolvedValue({
    team: [{ userId: 'producer', name: 'Brian Cole' }],
    items: [{ id: 'a', name: 'Cedar HOA' }],
  });
  h.read.mockResolvedValue(snapshot());
  h.action.mockResolvedValue({ ok: true, classification: null, accountName: 'Cedar HOA' });
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
  expect(h.policies.mock.calls[1][0]).toMatchObject({
    limit: 25,
    nextToken: 'page-2',
  });
  expect(h.policies).toHaveBeenCalledTimes(2);
});

it('retries a failed historical search with the same text without leaving the page', async () => {
  h.owner = true;
  h.policies
    .mockRejectedValueOnce(new Error('Search temporarily unavailable'))
    .mockResolvedValueOnce({
      data: [{ id: 'legacy', policyNumber: 'OLD-1' }],
      nextToken: null,
    });
  render(<Commissions />);
  await screen.findByText('Producer earned');
  fireEvent.click(screen.getByRole('tab', { name: 'Agreements & carriers' }));
  fireEvent.change(await screen.findByLabelText('Find historical policy number'), {
    target: { value: 'OLD' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Search historical policies' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Search temporarily unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Search historical policies' }));
  await screen.findByRole('option', { name: /OLD-1/ });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(h.policies).toHaveBeenCalledTimes(2);
  expect(h.policies.mock.calls[1][0]).toEqual(h.policies.mock.calls[0][0]);
});

it('lets the Owner confirm missing historical dates before adopting a policy', async () => {
  h.owner = true;
  h.read.mockResolvedValue({
    ...snapshot(),
    plans: [{ id: 'producer', producerId: 'producer', name: 'Avery', terms: [] }],
  });
  h.policies.mockResolvedValue({
    data: [
      {
        id: 'legacy',
        policyNumber: 'OLD-1',
        effectiveDate: null,
        expirationDate: null,
      },
    ],
    nextToken: null,
  });
  render(<Commissions />);
  await screen.findByText('Producer earned');
  fireEvent.click(screen.getByRole('tab', { name: 'Agreements & carriers' }));
  fireEvent.change(await screen.findByLabelText('Find historical policy number'), {
    target: { value: 'OLD' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Search historical policies' }));
  await screen.findByRole('option', { name: /OLD-1/ });
  fireEvent.change(screen.getByLabelText('Existing policy'), {
    target: { value: 'legacy' },
  });
  for (const [label, value] of [
    ['Original producer', 'producer'],
    ['Original bind date', '2026-01-01'],
    ['Original transaction', 'NEW'],
    ['Confirmed policy premium ($)', '1000'],
    ['Confirmed agency commission (%)', '12'],
    ['Confirmed effective date', '2026-01-01'],
    ['Confirmed expiration date', '2027-01-01'],
    ['Historical attribution and policy evidence', 'Original binder'],
  ]) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(h.action).toHaveBeenCalledWith(
      'adoptPolicy',
      expect.objectContaining({
        policyId: 'legacy',
        effectiveDate: '2026-01-01',
        expirationDate: '2027-01-01',
      }),
    ),
  );
});

it('requires explicit GIM rates and sends both standard and GIM agreement schedules', async () => {
  h.owner = true;
  render(<Commissions />);
  await screen.findByText('Producer earned');
  fireEvent.click(screen.getByRole('tab', { name: 'Agreements & carriers' }));
  fireEvent.change(await screen.findByLabelText('Producer'), {
    target: { value: 'producer' },
  });
  expect(screen.getByText(/GIM terms pending/)).toBeVisible();
  fireEvent.change(screen.getByLabelText('Account first-bind cutoff (optional)'), {
    target: { value: '2026-10-01' },
  });
  fireEvent.change(screen.getByLabelText('Agency receipt eligibility begins (optional)'), {
    target: { value: '2026-10-01' },
  });
  fireEvent.change(screen.getByLabelText('Effective from 1'), {
    target: { value: '2026-01-01' },
  });
  fireEvent.change(screen.getByLabelText('New business % 1'), {
    target: { value: '20' },
  });
  fireEvent.change(screen.getByLabelText('Renewal % 1'), {
    target: { value: '10' },
  });
  fireEvent.change(screen.getByLabelText('Agreement reference 1'), {
    target: { value: 'Signed standard plan' },
  });
  fireEvent.click(screen.getByLabelText('Configure GIM rates for period 1'));
  expect(screen.getByLabelText('GIM new business % 1')).toBeRequired();
  expect(screen.getByLabelText('GIM new business % 1')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('GIM new business % 1'), {
    target: { value: '5' },
  });
  fireEvent.change(screen.getByLabelText('GIM renewal % 1'), {
    target: { value: '0' },
  });
  fireEvent.change(screen.getByLabelText('GIM agreement reference 1'), {
    target: { value: 'GIM signed addendum' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save producer agreement' }));
  await waitFor(() =>
    expect(h.action).toHaveBeenCalledWith('savePlan', {
      accountBoundFrom: '2026-10-01',
      receiptsFrom: '2026-10-01',
      producerId: 'producer',
      name: 'Brian Cole',
      version: 0,
      terms: [
        {
          from: '2026-01-01',
          newBps: 2000,
          renewalBps: 1000,
          agreement: 'Signed standard plan',
          gim: { newBps: 500, renewalBps: 0, agreement: 'GIM signed addendum' },
        },
      ],
    }),
  );
});
it('searches and classifies a GIM account with dates and evidence and clears controls on role switch', async () => {
  h.owner = true;
  const view = render(<Commissions />);
  await screen.findByText('Producer earned');
  fireEvent.click(screen.getByRole('tab', { name: 'Agreements & carriers' }));
  fireEvent.change(await screen.findByRole('textbox', { name: /Find insured account/ }), {
    target: { value: 'Cedar' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Search accounts' }));
  await screen.findByRole('option', { name: 'Cedar HOA' });
  fireEvent.change(screen.getByLabelText('Insured account', { selector: 'select' }), {
    target: { value: 'a' },
  });
  expect(await screen.findByLabelText('Account classification 1')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('Original account binding history'), {
    target: { value: 'NEW' },
  });
  fireEvent.change(screen.getByLabelText('First-bind history reference'), {
    target: { value: 'Owner confirmed new account' },
  });
  fireEvent.change(screen.getByLabelText('Classification effective from 1'), {
    target: { value: '2026-01-01' },
  });
  fireEvent.change(screen.getByLabelText('Account classification 1'), {
    target: { value: 'GIM' },
  });
  fireEvent.change(screen.getByLabelText('Classification reference 1'), {
    target: { value: 'GIM management agreement' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save classification' }));
  await waitFor(() =>
    expect(h.action).toHaveBeenCalledWith('saveAccountClassification', {
      id: 'a',
      version: 0,
      neverBound: true,
      bindingEvidence: 'Owner confirmed new account',
      periods: [
        {
          from: '2026-01-01',
          classification: 'GIM',
          evidence: 'GIM management agreement',
        },
      ],
    }),
  );
  h.owner = false;
  view.rerender(<Commissions />);
  expect(screen.queryByLabelText('Account classification 1')).toBeNull();
  expect(screen.queryByText('GIM management agreement')).toBeNull();
});

it('does not offer an empty classification editor after a failed read and reloads saved terms on retry', async () => {
  h.owner = true;
  h.action.mockRejectedValueOnce(new Error('Classification unavailable')).mockResolvedValue({
    classification: {
      id: 'a',
      version: 4,
      firstBoundOn: '2026-01-01',
      bindingEvidence: 'Original binder',
      name: 'Cedar HOA',
      periods: [{ from: '2026-01-01', classification: 'GIM', evidence: 'Existing GIM evidence' }],
    },
    accountName: 'Cedar HOA',
  });
  render(<Commissions />);
  await screen.findByText('Producer earned');
  fireEvent.click(screen.getByRole('tab', { name: 'Agreements & carriers' }));
  fireEvent.change(await screen.findByRole('textbox', { name: /Find insured account/ }), {
    target: { value: 'Cedar' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Search accounts' }));
  await screen.findByRole('option', { name: 'Cedar HOA' });
  fireEvent.change(screen.getByLabelText('Insured account', { selector: 'select' }), {
    target: { value: 'a' },
  });
  await screen.findByText('Classification unavailable');
  expect(screen.queryByRole('button', { name: 'Save classification' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry account classification' }));
  expect(await screen.findByLabelText('Account classification 1')).toHaveValue('GIM');
  expect(screen.getByLabelText('Classification reference 1')).toHaveValue('Existing GIM evidence');
  fireEvent.click(screen.getByRole('button', { name: 'Save classification' }));
  await waitFor(() =>
    expect(h.action).toHaveBeenCalledWith(
      'saveAccountClassification',
      expect.objectContaining({ id: 'a', version: 4 }),
    ),
  );
});
