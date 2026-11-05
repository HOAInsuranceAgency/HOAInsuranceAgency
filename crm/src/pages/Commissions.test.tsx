import { invalidateLiveUpdates } from "../test/liveUpdates";
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { appendEntry } from '../../../shared/commissions';
import { commissionPolicy, line, statement } from '../test/commissionFixtures';
const h = vi.hoisted(() => ({
  owner: false,
  read: vi.fn(),
  action: vi.fn(),
  policies: vi.fn(),
  carriers: vi.fn(),
  communications: vi.fn(),
}));
vi.mock('../lib/auth', () => ({ useIsOwner: () => h.owner }));
vi.mock('../lib/commissions', () => ({
  readCommissions: h.read,
  commissionAction: h.action,
}));
vi.mock('../lib/client', () => ({
  client: {
    models: { Policy: { list: h.policies }, Carrier: { list: h.carriers } },
  },
  listAllPages: async (list: (token?: string) => Promise<{ data: unknown[] }>) =>
    (await list()).data,
  fmtMoney: (n: number) => `$${n.toFixed(2)}`,
  friendlyError: (e: Error) => e.message,
}));
vi.mock('../lib/communications', () => ({
  communicationRequest: h.communications,
}));
vi.mock('../components/ReportDownload', async () => ({ ReportDownload: () => null, ReportContext: (await import('react')).createContext({ disabled: false }) }));
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
  h.carriers.mockResolvedValue({ data: [], nextToken: null });
  h.communications.mockResolvedValue({
    team: [{ userId: 'producer', name: 'Brian Cole' }],
    items: [{ id: 'a', name: 'Cedar HOA' }],
  });
  h.read.mockResolvedValue(snapshot());
  h.action.mockResolvedValue({
    ok: true,
    classification: null,
    accountName: 'Cedar HOA',
  });
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
  h.read.mockRejectedValueOnce(Object.assign(new Error('Access inactive'), { name: 'Unauthorized' }));
  await invalidateLiveUpdates();
  await screen.findByRole('alert');
  expect(screen.queryByText('Producer earned')).toBeNull();
});

it('keeps payroll live after approval rotates its request ID and protects a later failed draft', async () => {
  h.owner = true;
  render(<Commissions />);
  await screen.findByText('Producer earned');
  fireEvent.click(screen.getByRole('tab', { name: 'Payroll' }));
  fireEvent.change(screen.getByLabelText('Producer'), { target: { value: 'producer' } });
  fireEvent.change(screen.getByLabelText('Include receipts through (inclusive)'), {
    target: { value: '2026-10-31' },
  });
  fireEvent.change(screen.getByLabelText('Scheduled pay date'), {
    target: { value: '2026-11-06' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Approve batch' }));
  await screen.findByText('Saved.');
  expect(h.action).toHaveBeenCalledExactlyOnceWith('preparePayroll', {
    producerId: 'producer', cutoff: '2026-10-31', payDate: '2026-11-06',
    requestId: expect.any(String),
  });
  expect(h.read).toHaveBeenCalledTimes(2);
  const firstRequestId = h.action.mock.calls[0][1].requestId;
  h.read.mockResolvedValue({ ...snapshot(), policies: snapshot().policies.map(policy => ({
    ...policy, version: policy.version + 1, producerName: 'Updated producer name',
  })) });
  await invalidateLiveUpdates(['OWNER']);
  expect(screen.getByRole('option', { name: 'Updated producer name' })).toBeVisible();
  expect(screen.getByRole('tab', { name: 'Payroll' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByLabelText('Include receipts through (inclusive)')).toHaveValue('2026-10-31');
  expect(screen.getByLabelText('Scheduled pay date')).toHaveValue('2026-11-06');
  expect(h.read).toHaveBeenCalledTimes(3);
  expect(h.action).toHaveBeenCalledTimes(1);

  fireEvent.change(screen.getByLabelText('Include receipts through (inclusive)'), {
    target: { value: '2026-11-02' },
  });
  h.action.mockRejectedValueOnce(new Error('Payroll approval unavailable'));
  fireEvent.click(screen.getByRole('button', { name: 'Approve batch' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Payroll approval unavailable');
  expect(h.action.mock.calls[1][1].requestId).not.toBe(firstRequestId);
  await invalidateLiveUpdates(['OWNER']);
  expect(h.read).toHaveBeenCalledTimes(3);
  expect(screen.getByLabelText('Include receipts through (inclusive)')).toHaveValue('2026-11-02');
  expect(h.action).toHaveBeenCalledTimes(2);
});

it('keeps edits made during payroll approval dirty after the submitted draft succeeds', async () => {
  h.owner = true;
  let finish!: (value: unknown) => void;
  h.action.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<Commissions />);
  await screen.findByText('Producer earned');
  fireEvent.click(screen.getByRole('tab', { name: 'Payroll' }));
  fireEvent.change(screen.getByLabelText('Producer'), { target: { value: 'producer' } });
  fireEvent.change(screen.getByLabelText('Include receipts through (inclusive)'), {
    target: { value: '2026-10-31' },
  });
  fireEvent.change(screen.getByLabelText('Scheduled pay date'), {
    target: { value: '2026-11-06' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Approve batch' }));
  expect(screen.getByLabelText('Include receipts through (inclusive)')).toBeDisabled();
  // Model a state update already queued when the request disabled the fields.
  fireEvent.change(screen.getByLabelText('Include receipts through (inclusive)'), {
    target: { value: '2026-11-02' },
  });
  await act(async () => finish({ ok: true }));
  await screen.findByText('Saved.');
  await invalidateLiveUpdates(['OWNER']);
  expect(h.read).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText('Include receipts through (inclusive)')).toHaveValue('2026-11-02');
  expect(h.action).toHaveBeenCalledTimes(1);
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
  await screen.findByText('Saved.');
  expect(screen.getByLabelText('Existing policy')).toHaveValue('');
  expect(h.read).toHaveBeenCalledTimes(2);
  h.read.mockResolvedValue({
    ...snapshot(),
    plans: [{ id: 'producer', producerId: 'producer', name: 'Updated historical producer', terms: [] }],
  });
  await invalidateLiveUpdates(['OWNER']);
  expect(within(screen.getByLabelText('Original producer')).getByRole('option', {
    name: 'Updated historical producer',
  })).toBeVisible();
  expect(screen.getByLabelText('Existing policy')).toHaveValue('');
  expect(h.read).toHaveBeenCalledTimes(3);
  expect(h.action).toHaveBeenCalledTimes(1);
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
      periods: [
        {
          from: '2026-01-01',
          classification: 'GIM',
          evidence: 'Existing GIM evidence',
        },
      ],
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

it('preserves unknown carrier receipt timing and recalculates actual receipts at the selected date', async () => {
  h.owner = true;
  render(<Commissions />);
  await screen.findByLabelText('Receipt reconciliation as of');
  fireEvent.change(screen.getByLabelText('Receipt reconciliation as of'), {
    target: { value: '2026-09-30' },
  });
  const balances = screen.getByLabelText('Carrier receipt balances as of 2026-09-30');
  expect(within(balances).getByText('Estimated through date').parentElement).toHaveTextContent(
    'Unknown',
  );
  expect(within(balances).getByText('Estimated gap through date').parentElement).toHaveTextContent(
    'Unknown',
  );
  expect(
    within(balances).getByText('Actual received through date').parentElement,
  ).toHaveTextContent('$0.00');
  fireEvent.change(screen.getByLabelText('Receipt reconciliation as of'), {
    target: { value: '2026-10-01' },
  });
  const next = screen.getByLabelText('Carrier receipt balances as of 2026-10-01');
  expect(within(next).getByText('Actual received through date').parentElement).toHaveTextContent(
    '$1000.00',
  );
  expect(within(next).getByText('Full-term agency estimate').parentElement).toHaveTextContent(
    '$12000.00',
  );
  expect(h.action).not.toHaveBeenCalled();
});

it('saves scoped dated carrier payment arrangements without inferring legacy schedule facts', async () => {
  h.owner = true;
  h.read.mockResolvedValue({
    ...snapshot(),
    carriers: [commissionPolicy().carrierTerms],
  });
  h.carriers.mockResolvedValue({
    data: [{ id: 'c', name: 'Carrier' }],
    nextToken: null,
  });
  render(<Commissions />);
  await screen.findByText('Producer earned');
  fireEvent.click(screen.getByRole('tab', { name: 'Agreements & carriers' }));
  fireEvent.change(await screen.findByLabelText('Carrier'), {
    target: { value: 'c' },
  });
  expect(
    screen.getByText('Legacy carrier terms need a structured payment arrangement.'),
  ).toBeVisible();
  expect(screen.getByRole('button', { name: 'Save carrier payment terms' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Add payment arrangement' }));
  expect(screen.getByLabelText('Commission basis 1')).toHaveValue('');
  expect(screen.getByLabelText('Receipt trigger 1')).toHaveValue('');
  expect(screen.getByLabelText('Remittance frequency 1')).toHaveValue('');
  expect(screen.getByLabelText('Additional lag days 1')).toHaveValue(null);
  for (const [label, value] of [
    ['Carrier terms effective from 1', '2026-01-01'],
    ['Carrier terms through 1 (optional)', '2026-12-31'],
    ['Lines of business 1 (blank = all)', 'Property, General Liability'],
    ['Business type 1', 'NEW'],
    ['Billing scope 1', 'DIRECT'],
    ['Commission basis 1', 'WRITTEN'],
    ['Commission payor 1', 'Wholesale Company'],
    ['Receipt trigger 1', 'EFFECTIVE'],
    ['Remittance frequency 1', 'MONTHLY'],
    ['Additional lag days 1', '0'],
    ['Statement cutoff day 1 (optional)', '25'],
    ['Remittance day 1 (optional)', '15'],
    ['Carrier agreement reference 1', 'Signed carrier schedule'],
    [
      'Original carrier wording / notes 1 (optional)',
      'Upfront even for monthly client installments',
    ],
  ])
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Save carrier payment terms' }));
  await waitFor(() =>
    expect(h.action).toHaveBeenCalledWith('saveCarrier', {
      id: 'c',
      version: 1,
      basis: 'WRITTEN',
      schedule: 'Monthly as collected',
      evidence: 'Signed carrier schedule',
      arrangements: [
        {
          id: expect.any(String),
          from: '2026-01-01',
          to: '2026-12-31',
          lines: ['Property', 'General Liability'],
          transaction: 'NEW',
          billType: 'DIRECT',
          basis: 'WRITTEN',
          payor: 'Wholesale Company',
          trigger: 'EFFECTIVE',
          cadence: 'MONTHLY',
          lagDays: 0,
          cutoffDay: 25,
          paymentDay: 15,
          evidence: 'Signed carrier schedule',
          notes: 'Upfront even for monthly client installments',
        },
      ],
    }),
  );
});

it('saves unequal estimated receipts as a partial forecast without posting earnings', async () => {
  h.owner = true;
  render(<Commissions />);
  await screen.findByText('Producer earned');
  fireEvent.click(screen.getByText('Manage expected receipts'));
  expect(screen.getByLabelText('Receipt forecast certainty')).toHaveValue('');
  expect(screen.getByLabelText('Receipt schedule coverage')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('Receipt forecast certainty'), {
    target: { value: 'false' },
  });
  fireEvent.change(screen.getByLabelText('Receipt schedule coverage'), {
    target: { value: 'false' },
  });
  fireEvent.change(screen.getByLabelText('Expected receipt date 1'), {
    target: { value: '2026-11-15' },
  });
  fireEvent.change(screen.getByLabelText('Expected agency commission ($) 1'), {
    target: { value: '500.25' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add expected receipt' }));
  fireEvent.change(screen.getByLabelText('Expected receipt date 2'), {
    target: { value: '2026-12-15' },
  });
  fireEvent.change(screen.getByLabelText('Expected agency commission ($) 2'), {
    target: { value: '1000' },
  });
  fireEvent.change(screen.getByLabelText('Receipt forecast evidence'), {
    target: { value: 'Carrier installment projection' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save receipt forecast' }));
  await waitFor(() =>
    expect(h.action).toHaveBeenCalledExactlyOnceWith('saveReceiptForecast', {
      policyId: 'p',
      version: 1,
      receiptForecast: {
        items: [
          { dueOn: '2026-11-15', agencyCents: 50025 },
          { dueOn: '2026-12-15', agencyCents: 100000 },
        ],
        evidence: 'Carrier installment projection',
        confirmed: false,
        complete: false,
      },
    }),
  );
});

it('allows a confirmed complete empty receipt schedule after cancellation without reversing actual receipts', async () => {
  h.owner = true;
  render(<Commissions />);
  await screen.findByText('Producer earned');
  fireEvent.click(screen.getByText('Manage expected receipts'));
  fireEvent.click(screen.getByRole('button', { name: 'Remove expected receipt 1' }));
  fireEvent.change(screen.getByLabelText('Receipt forecast certainty'), {
    target: { value: 'true' },
  });
  fireEvent.change(screen.getByLabelText('Receipt schedule coverage'), {
    target: { value: 'true' },
  });
  fireEvent.change(screen.getByLabelText('Receipt forecast evidence'), {
    target: { value: 'Final carrier cancellation statement' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save receipt forecast' }));
  await waitFor(() =>
    expect(h.action).toHaveBeenCalledExactlyOnceWith('saveReceiptForecast', {
      policyId: 'p',
      version: 1,
      receiptForecast: {
        items: [],
        evidence: 'Final carrier cancellation statement',
        confirmed: true,
        complete: true,
      },
    }),
  );
});

it('shows the safe producer receipt summary without private carrier terms or forecast controls', async () => {
  const p = appendEntry(commissionPolicy(), line(), statement(), 'e');
  h.read.mockResolvedValue({
    ...snapshot(),
    carriers: [],
    statements: [],
    policies: [
      {
        ...p,
        carrierTerms: undefined,
        reconciliationBalances: {
          asOf: '2026-11-04',
          fullTermEstimate: 1200000,
          forecastTotal: null,
          expectedToDate: null,
          receivedToDate: 100000,
          overdue: null,
          futureForecast: null,
          unallocatedForecast: null,
          confirmed: false,
          status: 'UNKNOWN',
          adjustmentReview: false,
        },
      },
    ],
  });
  render(<Commissions />);
  const balances = await screen.findByLabelText('Carrier receipt balances as of 2026-11-04');
  expect(within(balances).getByText(/Receipt timing unknown/)).toBeVisible();
  expect(
    within(balances).getByText('Actual received through date').parentElement,
  ).toHaveTextContent('$1000.00');
  expect(screen.queryByText('Manage expected receipts')).toBeNull();
  expect(screen.queryByLabelText('Receipt reconciliation as of')).toBeNull();
  expect(h.action).not.toHaveBeenCalled();
});

it('defers external agreement changes through a dirty draft and failed save without repeating a write', async () => {
  h.owner = true;
  render(<Commissions />);
  await screen.findByText('Producer earned');
  fireEvent.click(screen.getByRole('tab', { name: 'Agreements & carriers' }));
  fireEvent.change(await screen.findByLabelText('Producer'), { target: { value: 'producer' } });
  fireEvent.change(screen.getByLabelText('Effective from 1'), { target: { value: '2026-01-01' } });
  fireEvent.change(screen.getByLabelText('New business % 1'), { target: { value: '20' } });
  fireEvent.change(screen.getByLabelText('Renewal % 1'), { target: { value: '10' } });
  fireEvent.change(screen.getByLabelText('Agreement reference 1'), { target: { value: 'Draft schedule' } });
  h.read.mockResolvedValue({ ...snapshot(), plans: [{ id: 'producer', producerId: 'producer', version: 2, name: 'Brian Cole',
    terms: [{ from: '2026-01-01', newBps: 3000, renewalBps: 1500, agreement: 'New server schedule' }] }] });
  await invalidateLiveUpdates(['OWNER']);
  expect(h.read).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('New business % 1')).toHaveValue('20');
  h.action.mockRejectedValueOnce(new Error('Agreement save unavailable'));
  fireEvent.click(screen.getByRole('button', { name: 'Save producer agreement' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Agreement save unavailable');
  await invalidateLiveUpdates(['OWNER']);
  expect(h.action).toHaveBeenCalledTimes(1);
  expect(h.read).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Agreement reference 1')).toHaveValue('Draft schedule');
  fireEvent.change(screen.getByLabelText('Producer'), { target: { value: '' } });
  await waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
  fireEvent.change(screen.getByLabelText('Producer'), { target: { value: 'producer' } });
  expect(screen.getByLabelText('New business % 1')).toHaveValue('30');
  expect(h.action).toHaveBeenCalledTimes(1);
});
