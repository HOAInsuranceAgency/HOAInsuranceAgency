import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const h = vi.hoisted(() => ({
  rows: {} as Record<string, unknown[]>,
  loadCommercial: vi.fn(),
  saveReport: vi.fn(),
}));
vi.mock('../../lib/client', async original => ({
  ...await original<typeof import('../../lib/client')>(),
  client: { models: Object.fromEntries(['Account', 'Invoice', 'InvoiceLine', 'PfLoan', 'Policy', 'PfLoanPayment']
    .map(model => [model, { list: vi.fn(async () => ({ data: h.rows[model] ?? [] })) }])) },
}));
vi.mock('../../lib/commercial', async original => ({
  ...await original<typeof import('../../lib/commercial')>(), loadCommercial: h.loadCommercial,
}));
vi.mock('../../lib/reportDownload', async original => ({
  ...await original<typeof import('../../lib/reportDownload')>(), saveReport: h.saveReport,
}));
import FinanceTab from './FinanceTab';

beforeEach(() => {
  h.rows = {
    Account: [{ id: 'a', name: 'Cypress HOA' }],
    Invoice: [{ id: 'i', accountId: 'a', policyId: 'p', status: 'SENT', number: 'INV-1', stripeLinkAmountCents: 100000 }],
    PfLoan: [{ id: 'l', accountId: 'a', policyId: 'p', status: 'ACTIVE', balance: 800, amountFinanced: 800, paidThrough: 0 }],
    PfLoanPayment: [{ id: 'payment', accountId: 'a', postedAt: new Date().toISOString(), interest: 12.34 }],
  };
  h.loadCommercial.mockReset().mockResolvedValue({
    entries: { a: { accountId: 'a', salespersonId: 'sam' } },
    team: [{ userId: 'sam', name: 'Sam Rivera', salesperson: true }],
  });
  h.saveReport.mockReset();
});

it('shows incomplete overlapping A/R and exports the portfolio salesperson', async () => {
  render(<MemoryRouter><FinanceTab /></MemoryRouter>);
  await screen.findByRole('heading', { name: 'A/R aging' });
  expect(screen.getByText('A/R · Known non-billed (incomplete)')).toBeInTheDocument();
  expect(screen.getByText(/Non-billed total is incomplete: 1 financing records/)).toHaveTextContent('$800');
  const portfolio = screen.getByRole('heading', { name: 'Premium finance portfolio' }).closest('.card')! as HTMLElement;
  expect(within(portfolio).getByRole('columnheader', { name: 'Salesperson' })).toBeInTheDocument();
  expect(within(portfolio).getByText('Sam Rivera')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'In motion' })).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Interest income by salesperson' })).toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: 'Download Premium finance portfolio' }), { target: { value: 'csv' } });
  expect(h.saveReport).toHaveBeenCalledWith(expect.objectContaining({
    sections: expect.arrayContaining([expect.objectContaining({
      title: 'Outstanding financing',
      columns: expect.arrayContaining(['Salesperson']),
      rows: [expect.arrayContaining(['Sam Rivera', 'Review needed; excluded from non-billed A/R'])],
    })]),
  }), expect.any(Object), 'csv');
});

it('does not show or export a misleading unassigned report if attribution fails', async () => {
  h.loadCommercial.mockRejectedValue(new Error('Assignments unavailable'));
  render(<MemoryRouter><FinanceTab /></MemoryRouter>);
  expect(await screen.findByText('Assignments unavailable')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Premium finance portfolio' })).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: 'Download Finance summary' })).not.toBeInTheDocument();
});

it('keeps funded cancellations in the portfolio and non-billed debt until reconciled', async () => {
  h.rows.Invoice = [];
  h.rows.PfLoan = [{
    id: 'cancelled', accountId: 'a', policyId: 'p', status: 'CANCELLED', balance: 750,
    amountFinanced: 800, paidThrough: 1, expectedCarrierRefundAt: '2026-10-20',
    stripePaymentMethodId: 'saved-mandate',
  }];
  render(<MemoryRouter><FinanceTab /></MemoryRouter>);
  await screen.findByRole('heading', { name: 'Premium finance portfolio' });
  expect(screen.getByText('A/R · Total non-billed').closest('.stat')).toHaveTextContent('$750');
  expect(screen.getByText('Awaiting refund / reconciliation')).toBeInTheDocument();
  expect(screen.getByText('Stopped')).toBeInTheDocument();
});
