import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { appendEntry } from '../../../shared/commissions';
import { commissionPolicy, line, statement } from '../test/commissionFixtures';
const h = vi.hoisted(() => ({
  report: vi.fn(),
  owner: false,
  read: vi.fn(),
  action: vi.fn(),
  policies: vi.fn(),
  carriers: vi.fn(),
  createCarrier: vi.fn(),
  communications: vi.fn(),
}));
vi.mock('../lib/auth', () => ({ useIsOwner: () => h.owner }));
vi.mock('../lib/commissions', () => ({
  readCommissions: h.read,
  commissionAction: h.action,
}));
vi.mock('../lib/client', () => ({
  client: {
    models: { Policy: { list: h.policies }, Carrier: { list: h.carriers, create: h.createCarrier } },
  },
  listAllPages: async (list: (token?: string) => Promise<{ data: unknown[] }>) =>
    (await list()).data,
  fmtMoney: (n: number) => `$${n.toFixed(2)}`,
  friendlyError: (e: Error) => e.message,
}));
vi.mock('../lib/communications', () => ({
  communicationRequest: h.communications,
}));
vi.mock('../lib/editProtection', () => ({ useUnsavedChanges: vi.fn() }));
vi.mock('../components/ReportDownload', () => ({ ReportDownload: ({ report }: { report: unknown }) => { h.report(report); return null; } }));
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
  h.read.mockRejectedValueOnce(new Error('Access inactive'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh commissions' }));
  await screen.findByRole('alert');
  expect(screen.queryByText('Producer earned')).toBeNull();
});
it('cannot post pending eligibility even after settlement confirmation', async () => {
  h.owner = true;
  const data = snapshot();
  data.statements[0].lines = [line({ reviewStatus: 'PENDING', eligible: false })];
  h.read.mockResolvedValue(data);
  render(<Commissions />);
  await screen.findByText('Producer earned');
  fireEvent.click(screen.getByRole('tab', { name: 'Reconciliation' }));
  fireEvent.click(screen.getByLabelText(/I verified settlement evidence/));
  expect(screen.getByRole('button', { name: 'Post reconciled statement' })).toBeDisabled();
  expect(h.action).not.toHaveBeenCalled();
});
it('clears the parent commission view when a source-file request loses authorization', async () => {
  h.owner = true;
  render(<Commissions />);
  await screen.findByText('Producer earned');
  fireEvent.click(screen.getByRole('tab', { name: 'Reconciliation' }));
  h.action.mockRejectedValue(new Error('Not authorized'));
  fireEvent.click(screen.getByRole('button', { name: 'Download original statement' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Not authorized');
  expect(screen.queryByText('OCT-1')).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'Ledger' }));
  expect(screen.queryByText('Producer earned')).toBeNull();
});
it('clears the parent commission view when the payroll workspace loses authorization', async () => {
  h.owner = true;
  render(<Commissions />);
  await screen.findByText('Producer earned');
  h.action.mockRejectedValue(new Error('Not authorized'));
  fireEvent.click(screen.getByRole('tab', { name: 'Payroll' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Not authorized');
  expect(screen.queryByText('Individual payroll batches (manual exceptions)')).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'Ledger' }));
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
  fireEvent.click(await screen.findByRole('button', { name: 'Add existing policy' }));
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
  fireEvent.click(await screen.findByRole('button', { name: 'Add existing policy' }));
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
  fireEvent.click(await screen.findByRole('button', { name: 'Add existing policy' }));
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

it('configures a reusable plan before assigning it to a producer', async () => {
  h.owner = true;
  h.action.mockResolvedValue({ ok: true, id: 'standard' });
  render(<Commissions />);
  await screen.findByText('Producer earned');
  fireEvent.click(screen.getByRole('tab', { name: 'Agreements & carriers' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Add plan' }));
  await screen.findByLabelText('Plan name');
  for (const [label, value] of [['Plan name','Producer standard'],['Plan new business %','20'],['Plan renewal %','10'],['Plan document reference','Final plan']]) fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(screen.getByLabelText('Include GIM house-account rates'));
  for (const [label, value] of [['Plan GIM new business %','5'],['Plan GIM renewal %','0'],['GIM plan document reference','GIM addendum']]) fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Save commission plan' }));
  await waitFor(() => expect(h.action).toHaveBeenCalledWith('saveCommissionPlan', { id: expect.any(String), version: 0, name: 'Producer standard', newBps: 2000, renewalBps: 1000, agreement: 'Final plan', archived: false, gim: { newBps: 500, renewalBps: 0, agreement: 'GIM addendum' } }));
});
it('keeps employee effective dates and eligibility on the plan assignment', async () => {
  h.owner = true;
  h.read.mockResolvedValue({ ...snapshot(), planDefinitions: [{ id: 'standard', version: 3, name: 'Producer standard', newBps: 2000, renewalBps: 1000, agreement: 'Plan reference', archived: false }] });
  render(<Commissions />); await screen.findByText('Producer earned');
  fireEvent.click(screen.getByRole('tab', { name: 'Agreements & carriers' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Assign plan to Brian Cole' }));
  fireEvent.change(screen.getByLabelText('Commission plan 1'), { target: { value: 'standard:3' } });
  fireEvent.click(screen.getByText('Eligibility limits and end date (optional)'));
  for (const [label, value] of [['Assignment starts 1','2026-10-01'],['Employee agreement reference 1','Brian signed agreement'],['Account first-bind cutoff 1 (optional)','2026-10-01'],['Receipt eligibility begins 1 (optional)','2026-10-01']]) fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Save producer assignments' }));
  await waitFor(() => expect(h.action).toHaveBeenCalledWith('savePlanAssignments', expect.objectContaining({ producerId: 'producer', version: 0, assignments: [expect.objectContaining({ planId: 'standard', planVersion: 3, from: '2026-10-01', accountBoundFrom: '2026-10-01', receiptsFrom: '2026-10-01' })] })));
});
it('searches and classifies a GIM account with dates and evidence and clears controls on role switch', async () => {
  h.owner = true;
  const view = render(<Commissions />);
  await screen.findByText('Producer earned');
  fireEvent.click(screen.getByRole('tab', { name: 'Agreements & carriers' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Add account classification' }));
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
  fireEvent.click(await screen.findByRole('button', { name: 'Add account classification' }));
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
    '$1,000.00',
  );
  expect(within(next).getByText('Full-term agency estimate').parentElement).toHaveTextContent(
    '$12,000.00',
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
  fireEvent.click(await screen.findByRole('button', { name: 'Edit carrier Carrier' }));
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
  fireEvent.click(screen.getByText('Coverage and end date 1 (optional)'));
  fireEvent.click(screen.getByText('Statement dates 1 (optional)'));
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
  ).toHaveTextContent('$1,000.00');
  expect(screen.queryByText('Manage expected receipts')).toBeNull();
  expect(screen.queryByLabelText('Receipt reconciliation as of')).toBeNull();
  expect(h.action).not.toHaveBeenCalled();
});

it('exports shared employee earnings separately from the single agency receipt', async () => {
  const source=snapshot();
  source.policies[0].entries[0].producerCents=0;
  source.policies[0].entries[0].allocationId='split';
  h.read.mockResolvedValue({...source,earnings:[{id:'shared:avery',version:1,producerId:'producer',producerName:'Brian Cole',policyId:'p',policyNumber:'POL-1',accountName:'Cedar HOA',transaction:'NEW',entryId:'e',receivedOn:'2026-10-15',agencyCents:100000,producerBps:2000,amountCents:12000,shareBps:6000,source:'SHARED_RECEIPT',status:'PAYABLE'}]});
  render(<Commissions />);
  await screen.findByText('Shared commission & adjustment earnings');
  const report=h.report.mock.calls.at(-1)![0];
  expect(report.commissionLedger).toMatchObject({scope:'Your displayed earnings',agencyReceivedCents:100000,earnedCents:12000,paidCents:0});
  expect(report.sections[0].rows).toHaveLength(1);
  expect(report.sections[0].rows[0][6]).toBe(1000);
  expect(report.sections[0].rows[0].slice(7,9)).toEqual(['','']);
  expect(screen.getByText(/Your earnings \$120\.00/)).toBeVisible();
  expect(report.sections[1].rows).toHaveLength(1);
  expect(report.sections[1].rows[0].slice(5,9)).toEqual([60,20,120,'PAYABLE']);
  expect(report.sections[1].columns).not.toContain('Agency commission (USD)');
});

it('counts payable shared earnings in the policy summary without counting review or replaced amounts', async () => {
  h.owner = true;
  const source = snapshot();
  source.policies[0].entries[0].producerCents = 0;
  source.policies[0].entries[0].allocationId = 'split';
  const earning = {id:'shared:avery',version:1,producerId:'producer',producerName:'Avery Brooks',policyId:'p',policyNumber:'POL-1',accountName:'Cedar HOA',transaction:'NEW',entryId:'e',receivedOn:'2026-10-15',agencyCents:100000,producerBps:2000,amountCents:12000,shareBps:6000,source:'SHARED_RECEIPT',status:'PAYABLE'};
  h.read.mockResolvedValue({...source, earnings:[earning, {...earning,id:'shared:jordan',producerId:'jordan',producerName:'Jordan Hayes',producerBps:1600,shareBps:4000,amountCents:6400}, {...earning,id:'review',status:'REVIEW',amountCents:9000}, {...earning,id:'replaced',status:'REPLACED',amountCents:5000}]});
  render(<Commissions />);
  expect(await screen.findByText(/Employee earnings \$184\.00/)).toBeVisible();
  expect(screen.getByText(/Shared receipts use the individual shares and rates shown above/)).toBeVisible();
});

it('opens the setup checklist from the ledger and refreshes newly added employees', async () => {
  h.owner = true;
  render(<Commissions />);
  await screen.findByText('Producer earned');
  fireEvent.click(screen.getByRole('button', { name: 'Commission setup' }));
  await screen.findByRole('heading', { name: 'Agreements & carriers' });
  expect(screen.getByRole('link', { name: 'Carriers' })).toHaveAttribute('href', '#commission-carrier-terms');
  expect(screen.getByRole('link', { name: 'Policies' })).toHaveAttribute('href', '#commission-existing-policies');
  h.communications.mockResolvedValue({ team: [{ userId: 'producer', name: 'Brian Cole' }, { userId: 'second', name: 'Holly Martin' }] });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh team & carriers' }));
  await screen.findByRole('button', { name: 'Assign plan to Holly Martin' });
});
it('creates a missing carrier, refreshes the directory, and opens its payment terms without inventing terms', async () => {
  h.owner = true;
  render(<Commissions />);
  await screen.findByText('Producer earned');
  fireEvent.click(screen.getByRole('button', { name: 'Commission setup' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Add a carrier' }));
  expect(screen.getByRole('button', { name: 'Create carrier' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('New carrier name'), { target: { value: '  New Carrier  ' } });
  fireEvent.change(screen.getByLabelText('New carrier appointment status'), { target: { value: 'APPOINTED' } });
  h.createCarrier.mockResolvedValue({ data: { id: 'new-carrier', name: 'New Carrier', appointed: true } });
  h.carriers.mockResolvedValue({ data: [{ id: 'new-carrier', name: 'New Carrier', appointed: true }], nextToken: null });
  fireEvent.click(screen.getByRole('button', { name: 'Create carrier' }));
  await waitFor(() => expect(h.createCarrier).toHaveBeenCalledWith({ id: expect.any(String), name: 'New Carrier', appointed: true }));
  await screen.findByRole('button', { name: 'Use actual receipts only' });
  expect(screen.getByLabelText('Carrier')).toHaveValue('new-carrier');
  expect(screen.queryByLabelText('Commission payor 1')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Save carrier payment terms' })).toBeNull();
  expect(h.action).not.toHaveBeenCalledWith('saveCarrier', expect.anything());
});
it('prevents a duplicate carrier and preserves the draft when creation fails', async () => {
  h.owner = true;
  h.carriers.mockResolvedValue({ data: [{ id: 'existing', name: 'Existing Carrier' }], nextToken: null });
  render(<Commissions />);
  await screen.findByText('Producer earned');
  fireEvent.click(screen.getByRole('button', { name: 'Commission setup' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Add a carrier' }));
  fireEvent.change(screen.getByLabelText('New carrier name'), { target: { value: ' existing carrier ' } });
  fireEvent.change(screen.getByLabelText('New carrier appointment status'), { target: { value: 'PROSPECTIVE' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create carrier' }));
  await screen.findByText('This carrier is already in the directory. Choose it from the Carrier list below.');
  expect(h.createCarrier).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('New carrier name'), { target: { value: 'Another Carrier' } });
  h.createCarrier.mockResolvedValue({ data: null, errors: [{ message: 'Carrier service unavailable' }] });
  fireEvent.click(screen.getByRole('button', { name: 'Create carrier' }));
  await screen.findByText('Carrier service unavailable');
  expect(screen.getByLabelText('New carrier name')).toHaveValue('Another Carrier');
  expect(screen.getByLabelText('Carrier')).toHaveValue('');
});
it('does not expose owner setup controls in the producer view', async () => {
  render(<Commissions />);
  await screen.findByText('Producer earned');
  expect(screen.queryByRole('button', { name: 'Commission setup' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Agreements & carriers' })).toBeNull();
});

it('opens the linked setup view for an Owner without exposing it to a Producer', async () => {
  window.history.replaceState({}, '', '/commissions?tab=settings');
  try {
    h.owner = true;
    const view = render(<Commissions />);
    await screen.findByRole('heading', { name: 'Agreements & carriers' });
    h.owner = false;
    view.rerender(<Commissions />);
    await screen.findByText('Producer earned');
    expect(screen.queryByRole('heading', { name: 'Agreements & carriers' })).toBeNull();
  } finally {
    window.history.replaceState({}, '', '/');
  }
});

it('preserves cents from a carrier receipt throughout the ledger', async () => {
  const data = snapshot();
  data.policies[0].entries[0].agencyCents = 1980;
  data.policies[0].entries[0].producerCents = 396;
  h.read.mockResolvedValue(data);
  render(<Commissions />);
  const agencyTotal = await screen.findByText('Agency received');
  expect(agencyTotal.parentElement).toHaveTextContent('$19.80');
  expect(screen.getByText('Producer earned').parentElement).toHaveTextContent('$3.96');
  expect(screen.getAllByText('$19.80').length).toBeGreaterThan(0);
  expect(screen.getAllByText('$3.96').length).toBeGreaterThan(0);
});

it('allows setup reference data to be retried after a temporary lookup failure', async () => {
  h.owner = true;
  h.communications.mockRejectedValueOnce(new Error('Team lookup unavailable'));
  render(<Commissions />);
  await screen.findByText('Producer earned');
  fireEvent.click(screen.getByRole('button', { name: 'Commission setup' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Team lookup unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Retry team & carriers' }));
  await screen.findByRole('heading', { name: 'Agreements & carriers' });
  expect(screen.getByRole('button', { name: 'Assign plan to Brian Cole' })).toBeVisible();
});

it('shows saved plans, assignments, carrier schedules and account classifications without choosing dropdowns', async () => {
  h.owner = true;
  const definition = { id: 'plan', version: 2, name: 'Sales Rep', newBps: 2000, renewalBps: 1000, agreement: 'Plan document', archived: false };
  h.read.mockResolvedValue({ ...snapshot(), planDefinitions: [definition],
    plans: [{ id: 'producer', version: 1, producerId: 'producer', name: 'Brian Cole', terms: [{ from: '2026-10-05', newBps: 2000, renewalBps: 1000, agreement: 'Employee agreement', assignment: { id: 'assigned', planId: 'plan', planVersion: 2, planName: 'Sales Rep', planReference: 'Plan document' } }] }],
    carriers: [{ ...commissionPolicy().carrierTerms, arrangements: [{ id: 'default', from: '2026-01-01', basis: 'WRITTEN', payor: 'Test MGA', trigger: 'EFFECTIVE', cadence: 'MONTHLY', lagDays: 2, evidence: 'Schedule evidence' }] }],
    accounts: [{ id: 'a', name: 'Cedar HOA', version: 1, firstBoundOn: '2026-10-01', periods: [{ from: '2026-10-01', classification: 'STANDARD', evidence: 'Reviewed' }] }],
  });
  render(<Commissions />);
  fireEvent.click(screen.getByRole('button', { name: 'Commission setup' }));
  expect(await screen.findByRole('table', { name: 'Saved commission plans' })).toHaveTextContent('Sales Rep');
  expect(screen.getByRole('table', { name: 'Saved employee assignments' })).toHaveTextContent('2026-10-05');
  expect(screen.getByRole('table', { name: 'Saved carrier settings' })).toHaveTextContent('Test MGA');
  expect(screen.getByRole('table', { name: 'Saved account classifications' })).toHaveTextContent('Cedar HOA');
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.queryByLabelText('Plan name')).toBeNull();
  expect(screen.getByLabelText('Original bind date')).not.toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Edit assignment for Brian Cole' }));
  expect(screen.getByLabelText('Assignment starts 1')).toHaveValue('2026-10-05');
});
it('enables actual receipts without asking for payment timing or guessing carrier terms', async () => {
  h.owner = true;
  h.carriers.mockResolvedValue({ data: [{ id: 'c', name: 'Carrier' }], nextToken: null });
  render(<Commissions />);
  fireEvent.click(screen.getByRole('button', { name: 'Commission setup' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Configure carrier' }));
  fireEvent.change(screen.getByLabelText('Carrier'), { target: { value: 'c' } });
  expect(screen.queryByLabelText('Carrier terms effective from 1')).toBeNull();
  expect(screen.queryByLabelText('Commission payor 1')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Use actual receipts only' }));
  await waitFor(() => expect(h.action).toHaveBeenCalledWith('saveCarrier', { id: 'c', version: 0, receiptOnly: true }));
});
it('prefills the plan reference for an assignment without clearing an employee-specific agreement', async () => {
  h.owner = true;
  h.read.mockResolvedValue({ ...snapshot(), planDefinitions: [
    { id: 'a', version: 1, name: 'Plan A', newBps: 2000, renewalBps: 1000, agreement: 'Plan A agreement', archived: false },
    { id: 'b', version: 1, name: 'Plan B', newBps: 1600, renewalBps: 800, agreement: 'Plan B agreement', archived: false },
  ] });
  render(<Commissions />);
  fireEvent.click(screen.getByRole('button', { name: 'Commission setup' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Assign plan to Brian Cole' }));
  fireEvent.change(screen.getByLabelText('Commission plan 1'), { target: { value: 'a:1' } });
  expect(screen.getByLabelText('Employee agreement reference 1')).toHaveValue('Plan A agreement');
  fireEvent.change(screen.getByLabelText('Employee agreement reference 1'), { target: { value: 'Signed individual agreement' } });
  fireEvent.change(screen.getByLabelText('Commission plan 1'), { target: { value: 'b:1' } });
  expect(screen.getByLabelText('Employee agreement reference 1')).toHaveValue('Signed individual agreement');
});
