import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
vi.mock(
  '../lib/client',
  () => import('../../scripts/commercial-preview/fixtures'),
);
vi.mock(
  '../lib/communications',
  () => import('../../scripts/commercial-preview/fixtures'),
);
import { AdminContext } from '../lib/auth';
const saveReport = vi.hoisted(() => vi.fn());
vi.mock('../lib/reportDownload', async original => ({ ...await original<typeof import('../lib/reportDownload')>(), saveReport }));
import AccountsList from '../pages/AccountsList';

beforeEach(() => {
  saveReport.mockClear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-09-14T13:00:00Z');
});
afterEach(() => vi.useRealTimers());

it('keeps unfinished packages in Leads and shows the same visible salesperson filter on Clients', async () => {
  const page = render(
    <AdminContext.Provider value={true}><MemoryRouter>
      <AccountsList stage="LEAD" />
    </MemoryRouter></AdminContext.Provider>,
  );
  expect(await screen.findByText('Binding in progress')).toBeTruthy();
  expect(await screen.findByText('$250')).toBeTruthy();
  expect(screen.getByText('Quote form')).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', { name: 'Salesperson' }), {
    target: { value: 'champ' },
  });
  expect(screen.getByText('No leads found.')).toBeTruthy();
  page.rerender(
    <AdminContext.Provider value={true}><MemoryRouter>
      <AccountsList stage="CLIENT" />
    </MemoryRouter></AdminContext.Provider>,
  );
  expect(await screen.findByText('No clients found.')).toBeTruthy();
  expect(screen.getByRole('combobox', { name: 'Salesperson' })).toHaveValue('champ');
  fireEvent.change(screen.getByRole('combobox', { name: 'Salesperson' }), { target: { value: '' } });
  expect(await screen.findByText('Cedar House — partially bound')).toBeTruthy();
  expect(screen.getByRole('columnheader', { name: 'City' })).toBeTruthy();
  expect(screen.getByRole('columnheader', { name: 'State' })).toBeTruthy();
  expect(screen.getByRole('columnheader', { name: 'Salesperson' })).toBeTruthy();
  expect(screen.queryByRole('columnheader', { name: 'Deal champion' })).toBeNull();
});

it.each(['LEAD', 'CLIENT'] as const)('hides salesperson columns, filters and exports for non-admin %s accounts', async stage => {
  render(<AdminContext.Provider value={false}><MemoryRouter><AccountsList stage={stage} /></MemoryRouter></AdminContext.Provider>);
  await screen.findByText('Cedar House — partially bound');
  expect(screen.queryByRole('combobox', { name: 'Salesperson' })).toBeNull();
  expect(screen.queryByRole('columnheader', { name: 'Salesperson' })).toBeNull();
  fireEvent.change(screen.getByRole('combobox', { name: `Download ${stage === 'LEAD' ? 'Leads' : 'Clients'}` }), { target: { value: 'csv' } });
  const report = saveReport.mock.calls[0][0], section = report.sections[0];
  expect(section.columns).not.toContain('Salesperson');
  expect(report.filters).not.toContain('Salesperson');
  expect(section.rows.length).toBeGreaterThan(0);
  expect(section.rows.every((r: unknown[]) => r.length === section.columns.length)).toBe(true);
});
it.each(['LEAD', 'CLIENT'] as const)('retains salesperson columns, filters and exports for admin %s accounts', async stage => {
  render(<AdminContext.Provider value={true}><MemoryRouter><AccountsList stage={stage} /></MemoryRouter></AdminContext.Provider>);
  await screen.findByText('Cedar House — partially bound');
  expect(screen.getByRole('combobox', { name: 'Salesperson' })).toBeTruthy();
  expect(screen.getByRole('columnheader', { name: 'Salesperson' })).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', { name: `Download ${stage === 'LEAD' ? 'Leads' : 'Clients'}` }), { target: { value: 'csv' } });
  const report = saveReport.mock.calls[0][0], section = report.sections[0];
  expect(section.columns).toContain('Salesperson');
  expect(report.filters).toContain('Salesperson');
  expect(section.rows.every((r: unknown[]) => r.length === section.columns.length)).toBe(true);
});
it('ignores a formerly selected salesperson filter when admin access is removed', async () => {
  const page = render(<AdminContext.Provider value={true}><MemoryRouter><AccountsList stage="LEAD" /></MemoryRouter></AdminContext.Provider>);
  await screen.findByText('Cedar House — partially bound');
  fireEvent.change(screen.getByRole('combobox', { name: 'Salesperson' }), { target: { value: 'champ' } });
  expect(screen.getByText('No leads found.')).toBeTruthy();
  page.rerender(<AdminContext.Provider value={false}><MemoryRouter><AccountsList stage="LEAD" /></MemoryRouter></AdminContext.Provider>);
  expect(await screen.findByText('Cedar House — partially bound')).toBeTruthy();
  expect(screen.queryByRole('combobox', { name: 'Salesperson' })).toBeNull();
});
