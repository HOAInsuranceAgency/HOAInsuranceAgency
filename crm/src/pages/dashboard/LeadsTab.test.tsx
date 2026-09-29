import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { emptyCommercialPlan } from '../../../../shared/quotePackages';

const h = vi.hoisted(() => ({ accounts: vi.fn(), quotes: vi.fn(), policies: vi.fn(), commercial: vi.fn(), contacts: vi.fn() }));
vi.mock('../../lib/client', async original => ({
  ...await original<typeof import('../../lib/client')>(),
  client: { models: { Account: { list: h.accounts }, Quote: { list: h.quotes }, Policy: { list: h.policies } } },
}));
vi.mock('../../lib/commercial', async original => ({ ...await original<typeof import('../../lib/commercial')>(), loadCommercial: h.commercial }));
vi.mock('../../lib/lastContact', () => ({ useLastContacts: (ids: string[]) => { h.contacts(ids); return { contacts: {}, loading: false, error: '' }; } }));
vi.mock('../../components/OpportunityEstimate', () => ({ OpportunityEstimate: () => <span>No estimate</span> }));
import LeadsTab from './LeadsTab';

beforeEach(() => {
  vi.clearAllMocks();
  h.accounts.mockImplementation(({ filter }: { filter: { stage: { eq: string } } }) => Promise.resolve({ data: filter.stage.eq === 'LEAD' ? [
    { id: 'alice-lead', name: 'Alice account', stage: 'LEAD', createdAt: '2026-09-20T12:00:00Z' },
    { id: 'bob-lead', name: 'Bob account', stage: 'LEAD', createdAt: '2026-09-20T12:00:00Z' },
    { id: 'unassigned-lead', name: 'Unassigned account', stage: 'LEAD' },
    { id: 'lost-lead', name: 'Lost account', stage: 'LEAD' },
  ] : [] }));
  h.quotes.mockResolvedValue({ data: [] });
  h.policies.mockResolvedValue({ data: [] });
  h.commercial.mockResolvedValue({ entries: Object.fromEntries([
    ['alice-lead', 'alice', 'ACTIVE'], ['bob-lead', 'bob', 'ACTIVE'], ['unassigned-lead', undefined, 'ACTIVE'], ['lost-lead', 'alice', 'LOST'],
  ].map(([id, salespersonId, disposition]) => [id, { accountId: id, salespersonId, disposition, plan: emptyCommercialPlan(id!) }])), team: [
    { userId: 'alice', name: 'Alice', salesperson: true }, { userId: 'bob', name: 'Bob', salesperson: true },
  ] });
});

it('requires a salesperson before displaying or exporting the lead work list, including Unassigned', async () => {
  render(<MemoryRouter><LeadsTab /></MemoryRouter>);
  const picker = await screen.findByRole('combobox', { name: 'Salesperson' });
  const download = screen.getByRole('combobox', { name: 'Download Lead work list' });
  expect(picker).toHaveValue('');
  expect(download).toBeDisabled();
  expect(screen.getByText('Choose a salesperson to view their lead work list.')).toBeInTheDocument();
  expect(screen.queryByText('Alice account')).not.toBeInTheDocument();
  expect(within(picker).queryByRole('option', { name: 'All salespeople' })).not.toBeInTheDocument();
  expect(h.contacts).toHaveBeenLastCalledWith([]);

  fireEvent.change(picker, { target: { value: 'alice' } });
  expect(await screen.findByText('Alice account')).toBeInTheDocument();
  expect(screen.queryByText('Bob account')).not.toBeInTheDocument();
  expect(screen.queryByText('Lost account')).not.toBeInTheDocument();
  expect(download).toBeEnabled();
  expect(h.contacts).toHaveBeenLastCalledWith(['alice-lead']);

  fireEvent.change(picker, { target: { value: 'unassigned' } });
  expect(await screen.findByText('Unassigned account')).toBeInTheDocument();
  expect(screen.queryByText('Alice account')).not.toBeInTheDocument();
  expect(h.contacts).toHaveBeenLastCalledWith(['unassigned-lead']);

  fireEvent.change(picker, { target: { value: '' } });
  expect(download).toBeDisabled();
  expect(screen.queryByText('Unassigned account')).not.toBeInTheDocument();
});

it('does not publish apparently unassigned charts if assignment data cannot load', async () => {
  h.commercial.mockRejectedValue(new Error('Assignments unavailable'));
  render(<MemoryRouter><LeadsTab /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText('Assignments unavailable')).toBeInTheDocument());
  expect(screen.queryByRole('group', { name: 'Open leads per person' })).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: 'Download Lead work list' })).not.toBeInTheDocument();
});

it('clears the visible selection and blocks exports when a salesperson disappears after refresh', async () => {
  render(<MemoryRouter><LeadsTab /></MemoryRouter>);
  const picker = await screen.findByRole('combobox', { name: 'Salesperson' });
  fireEvent.change(picker, { target: { value: 'alice' } });
  expect(await screen.findByText('Alice account')).toBeInTheDocument();
  h.commercial.mockResolvedValue({
    entries: { 'alice-lead': { accountId: 'alice-lead', salespersonId: 'bob', plan: emptyCommercialPlan('alice-lead') } },
    team: [{ userId: 'bob', name: 'Bob', salesperson: true }],
  });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(picker).toHaveValue(''));
  expect(screen.getByRole('combobox', { name: 'Download Lead work list' })).toBeDisabled();
  expect(screen.getByText('Choose a salesperson to view their lead work list.')).toBeInTheDocument();
  expect(screen.queryByText('Alice account')).not.toBeInTheDocument();
  expect(h.contacts).toHaveBeenLastCalledWith([]);
});

it('work list standing excludes unselected package alternatives', async () => {
  h.commercial.mockResolvedValue({
    entries: { 'alice-lead': { accountId: 'alice-lead', salespersonId: 'alice', plan: {
      ...emptyCommercialPlan('alice-lead'), selectedOptionId: 'chosen', options: [
        { id: 'chosen', name: 'Chosen', quoteIds: ['q1'] }, { id: 'alternative', name: 'Alternative', quoteIds: ['q2'] },
      ],
    } } },
    team: [{ userId: 'alice', name: 'Alice', salesperson: true }],
  });
  h.quotes.mockResolvedValue({ data: [{ id: 'q1', accountId: 'alice-lead', status: 'DRAFT' }, { id: 'q2', accountId: 'alice-lead', status: 'PRESENTED' }] });
  render(<MemoryRouter><LeadsTab /></MemoryRouter>);
  fireEvent.change(await screen.findByRole('combobox', { name: 'Salesperson' }), { target: { value: 'alice' } });
  const row = (await screen.findByText('Alice account')).closest('tr')!;
  expect(within(row).getByText('DRAFT')).toBeInTheDocument();
  expect(within(row).queryByText('PRESENTED')).not.toBeInTheDocument();
});
