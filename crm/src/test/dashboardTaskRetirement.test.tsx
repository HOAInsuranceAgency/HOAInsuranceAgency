import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
const h = vi.hoisted(() => ({ list: vi.fn(), retiredTasks: vi.fn() }));
vi.mock('../lib/client', async original => ({
  ...await original<typeof import('../lib/client')>(),
  client: { models: Object.fromEntries([
    ...['Account', 'Quote', 'Policy', 'Carrier', 'Invoice', 'PfLoan', 'InvoiceLine', 'PfLoanPayment'].map(name => [name, { list: h.list }]),
    ['MarketingTask', { list: h.retiredTasks }],
  ]) },
}));
import PerformanceTab from '../pages/dashboard/PerformanceTab';
import LeadsTab from '../pages/dashboard/LeadsTab';
import FinanceTab from '../pages/dashboard/FinanceTab';
beforeEach(() => { h.list.mockReset().mockResolvedValue({ data: [] }); h.retiredTasks.mockReset().mockRejectedValue(new Error('Retired task storage must not be read')); });
it.each([PerformanceTab, LeadsTab, FinanceTab])('loads %s without querying retired task storage', async Component => {
  render(<MemoryRouter><Component /></MemoryRouter>);
  await screen.findByRole('button', { name: 'Refresh' });
  expect(h.list).toHaveBeenCalled();
  expect(h.retiredTasks).not.toHaveBeenCalled();
  expect(screen.queryByText(/task open|tasks open|Window missed|Submit by/)).toBeNull();
});
