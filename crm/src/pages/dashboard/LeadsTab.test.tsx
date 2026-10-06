import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { emptyCommercialPlan } from '../../../../shared/quotePackages';

const h = vi.hoisted(() => ({ accounts: vi.fn(), quotes: vi.fn(), policies: vi.fn(), commercial: vi.fn(), assignments: vi.fn(), request: vi.fn(), contacts: vi.fn(), quoteRows: [] as { id: string; accountId: string; status: string }[], selections: [] as { accountId: string; selectedQuoteIds: string[]; alternativeQuoteIds: string[] }[] }));
vi.mock('../../lib/client', async original => ({
  ...await original<typeof import('../../lib/client')>(),
  client: { models: { Account: { listAccountByStageAndName: h.accounts }, Quote: { list: h.quotes }, Policy: { list: h.policies } } },
}));
vi.mock('../../lib/commercial', async original => ({ ...await original<typeof import('../../lib/commercial')>(), loadCommercial: h.commercial }));
vi.mock('../../lib/dashboardAssignments', () => ({ loadAssignments: h.assignments }));
vi.mock('../../lib/communications', () => ({ communicationRequest: h.request }));
vi.mock('../../lib/lastContact', () => ({ useLastContacts: (ids: string[]) => { h.contacts(ids); return { contacts: {}, loading: false, error: '' }; } }));
vi.mock('../../components/OpportunityEstimate', () => ({ OpportunityEstimate: () => <span>No estimate</span> }));
import LeadsTab from './LeadsTab';

beforeEach(() => {
  vi.resetAllMocks();
  h.quoteRows = []; h.selections = [];
  h.accounts.mockImplementation(({ stage }: { stage: string }) => Promise.resolve({ data: stage === 'LEAD' ? [
    { id: 'alice-lead', name: 'Alice account', stage: 'LEAD', createdAt: '2026-09-20T12:00:00Z' },
    { id: 'bob-lead', name: 'Bob account', stage: 'LEAD', createdAt: '2026-09-20T12:00:00Z' },
    { id: 'unassigned-lead', name: 'Unassigned account', stage: 'LEAD' },
    { id: 'lost-lead', name: 'Lost account', stage: 'LEAD' },
  ] : [] }));
  h.quotes.mockResolvedValue({ data: [] });
  h.policies.mockResolvedValue({ data: [] });
  const commercial = { entries: Object.fromEntries([
    ['alice-lead', 'alice', 'ACTIVE'], ['bob-lead', 'bob', 'ACTIVE'], ['unassigned-lead', undefined, 'ACTIVE'], ['lost-lead', 'alice', 'LOST'],
  ].map(([id, salespersonId, disposition]) => [id, { accountId: id, salespersonId, disposition, plan: emptyCommercialPlan(id!) }])), team: [
    { userId: 'alice', name: 'Alice', salesperson: true }, { userId: 'bob', name: 'Bob', salesperson: true },
  ] };
  h.commercial.mockResolvedValue(commercial);
  h.assignments.mockResolvedValue(commercial);
  h.request.mockImplementation(async (operation, input) => {
    if (operation === 'dashboardLeadPlansPage') return { items: h.selections };
    if (operation === 'dashboardOpenQuotesPage') return { items: h.quoteRows.filter(quote => quote.status === input.status) };
    if (operation === 'dashboardBoundPoliciesPage') return { items: [] };
    if (operation === 'dashboardQuotesPage') return { items: h.quoteRows.filter(quote => input.accountIds.includes(quote.accountId)) };
    if (operation === 'dashboardQuoteStates') return { items: h.quoteRows.filter(quote => input.quoteIds.includes(quote.id)), missingIds: input.quoteIds.filter((id: string) => !h.quoteRows.some(quote => quote.id === id)) };
    throw new Error(`Unexpected report operation ${operation}`);
  });
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
  expect(h.commercial).not.toHaveBeenCalled();
  expect(h.request.mock.calls.some(([, input]) => input.details)).toBe(false);
  expect(h.quotes).not.toHaveBeenCalled(); expect(h.policies).not.toHaveBeenCalled();

  fireEvent.change(picker, { target: { value: 'alice' } });
  expect(await screen.findByText('Alice account')).toBeInTheDocument();
  expect(screen.queryByText('Bob account')).not.toBeInTheDocument();
  expect(screen.queryByText('Lost account')).not.toBeInTheDocument();
  expect(download).toBeEnabled();
  expect(h.contacts).toHaveBeenLastCalledWith(['alice-lead']);
  expect(h.commercial).toHaveBeenCalledExactlyOnceWith(['alice-lead']);
  expect(h.request).toHaveBeenCalledWith('dashboardQuotesPage', { accountIds: ['alice-lead'], details: true });

  fireEvent.change(picker, { target: { value: 'unassigned' } });
  expect(await screen.findByText('Unassigned account')).toBeInTheDocument();
  expect(screen.queryByText('Alice account')).not.toBeInTheDocument();
  expect(h.contacts).toHaveBeenLastCalledWith(['unassigned-lead']);

  fireEvent.change(picker, { target: { value: '' } });
  expect(download).toBeDisabled();
  expect(screen.queryByText('Unassigned account')).not.toBeInTheDocument();
});

it('does not publish apparently unassigned charts if assignment data cannot load', async () => {
  h.assignments.mockRejectedValue(new Error('Assignments unavailable'));
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
  h.assignments.mockResolvedValue({
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
  h.quoteRows = [{ id: 'q1', accountId: 'alice-lead', status: 'DRAFT' }, { id: 'q2', accountId: 'alice-lead', status: 'PRESENTED' }];
  render(<MemoryRouter><LeadsTab /></MemoryRouter>);
  fireEvent.change(await screen.findByRole('combobox', { name: 'Salesperson' }), { target: { value: 'alice' } });
  const row = (await screen.findByText('Alice account')).closest('tr')!;
  expect(within(row).getByText('DRAFT')).toBeInTheDocument();
  expect(within(row).queryByText('PRESENTED')).not.toBeInTheDocument();
});

it('keeps charts available when selected work-list package details fail', async () => {
  h.commercial.mockRejectedValue(new Error('Selected lead details unavailable'));
  render(<MemoryRouter><LeadsTab /></MemoryRouter>);
  fireEvent.change(await screen.findByRole('combobox', { name: 'Salesperson' }), { target: { value: 'alice' } });
  expect(await screen.findByRole('alert')).toHaveTextContent('Selected lead details unavailable');
  expect(screen.getByRole('group', { name: 'Open leads per person' })).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Download Open leads per person' })).toBeEnabled();
  expect(screen.getByRole('combobox', { name: 'Download Lead work list' })).toBeDisabled();
  expect(screen.queryByText('Alice account')).not.toBeInTheDocument();
});

it('includes a partially bound client whose remaining selected quote is missing', async () => {
  h.accounts.mockImplementation(({ stage }) => Promise.resolve({ data: stage === 'CLIENT' ? [{ id: 'partial', name: 'Partially bound client', stage: 'CLIENT' }] : [] }));
  h.quoteRows = [{ id: 'q1', accountId: 'partial', status: 'BOUND' }];
  h.selections = [{ accountId: 'partial', selectedQuoteIds: ['q1', 'missing'], alternativeQuoteIds: [] }];
  const commercial = { entries: { partial: { accountId: 'partial', salespersonId: 'alice', disposition: 'BOUND', plan: {
    ...emptyCommercialPlan('partial'), selectedOptionId: 'chosen', options: [{ id: 'chosen', name: 'Chosen', quoteIds: ['q1', 'missing'] }],
  } } }, team: [{ userId: 'alice', name: 'Alice', salesperson: true }] };
  h.assignments.mockResolvedValue(commercial); h.commercial.mockResolvedValue(commercial);
  render(<MemoryRouter><LeadsTab /></MemoryRouter>);
  fireEvent.change(await screen.findByRole('combobox', { name: 'Salesperson' }), { target: { value: 'alice' } });
  expect(await screen.findByText('Partially bound client')).toBeInTheDocument();
  expect(h.commercial).toHaveBeenCalledExactlyOnceWith(['partial']);
  expect(screen.getByText('Selected package needs review')).toBeInTheDocument();
});

it('requires both complete plans and quote details before displaying or exporting selected work', async () => {
  const initial = h.request.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  h.request.mockImplementation((operation, input) => input.details ? new Promise(resolve => { finish = resolve; }) : initial(operation, input));
  render(<MemoryRouter><LeadsTab /></MemoryRouter>);
  fireEvent.change(await screen.findByRole('combobox', { name: 'Salesperson' }), { target: { value: 'alice' } });
  await waitFor(() => expect(h.commercial).toHaveBeenCalledWith(['alice-lead']));
  expect(screen.queryByText('Alice account')).not.toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Download Lead work list' })).toBeDisabled();
  expect(screen.getByRole('combobox', { name: 'Download Open leads per person' })).toBeEnabled();
  await act(async () => finish({ items: [{ id: 'q1', accountId: 'alice-lead', status: 'DECLINED' }] }));
  expect(await screen.findByText('Alice account')).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Download Lead work list' })).toBeEnabled();
  expect(screen.getByText('DECLINED')).toBeInTheDocument();
});

it('rejects stale quote details after switching salespeople and blocks failed detail exports', async () => {
  const initial = h.request.getMockImplementation()!;
  let finishAlice!: (value: unknown) => void;
  h.request.mockImplementation((operation, input) => input.details && input.accountIds.includes('alice-lead')
    ? new Promise(resolve => { finishAlice = resolve; }) : initial(operation, input));
  render(<MemoryRouter><LeadsTab /></MemoryRouter>);
  const picker = await screen.findByRole('combobox', { name: 'Salesperson' });
  fireEvent.change(picker, { target: { value: 'alice' } });
  await waitFor(() => expect(finishAlice).toBeTypeOf('function'));
  fireEvent.change(picker, { target: { value: 'bob' } });
  expect(await screen.findByText('Bob account')).toBeInTheDocument();
  await act(async () => finishAlice({ items: [{ id: 'q1', accountId: 'alice-lead', status: 'PRESENTED' }] }));
  expect(screen.queryByText('Alice account')).not.toBeInTheDocument();
  expect(screen.getByText('Bob account')).toBeInTheDocument();
  expect(h.contacts).toHaveBeenLastCalledWith(['bob-lead']);
  h.request.mockImplementation((operation, input) => input.details ? Promise.reject(new Error('Quote details unavailable')) : initial(operation, input));
  fireEvent.change(picker, { target: { value: 'alice' } });
  expect(await screen.findByRole('alert')).toHaveTextContent('Quote details unavailable');
  expect(screen.queryByText('Alice account')).not.toBeInTheDocument();
  expect(screen.queryByText('Bob account')).not.toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Download Lead work list' })).toBeDisabled();
});

it('retains lead data for transient failures but clears denied charts and work rows through retry', async () => {
  const initial = h.assignments.getMockImplementation()!;
  render(<MemoryRouter><LeadsTab /></MemoryRouter>);
  fireEvent.change(await screen.findByRole('combobox', { name: 'Salesperson' }), { target: { value: 'alice' } });
  expect(await screen.findByText('Alice account')).toBeVisible();
  h.assignments.mockRejectedValueOnce(new Error('Report temporarily unavailable'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText(/Report temporarily unavailable/);
  expect(screen.getByText('Alice account')).toBeVisible();
  expect(screen.getByRole('combobox', { name: 'Download Lead work list' })).toBeDisabled();
  h.assignments.mockRejectedValueOnce(Object.assign(new Error('Credentials changed'), { name: 'Unauthorized' }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Credentials changed');
  expect(screen.queryByText('Alice account')).toBeNull();
  expect(screen.queryByRole('group', { name: 'Open leads per person' })).toBeNull();
  expect(screen.queryByRole('combobox', { name: 'Download Lead work list' })).toBeNull();
  let finish!: (value: unknown) => void;
  h.assignments.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(screen.getByText('Loading…')).toBeVisible();
  expect(screen.queryByText('Alice account')).toBeNull();
  await act(async () => finish(await initial()));
  expect(await screen.findByText('Alice account')).toBeVisible();
});

it('keeps denied lead details unavailable while retrying the selected work list', async () => {
  const initial = h.commercial.getMockImplementation()!;
  render(<MemoryRouter><LeadsTab /></MemoryRouter>);
  fireEvent.change(await screen.findByRole('combobox', { name: 'Salesperson' }), { target: { value: 'alice' } });
  expect(await screen.findByText('Alice account')).toBeVisible();
  h.commercial.mockRejectedValueOnce(Object.assign(new Error('Credentials changed'), { name: 'Unauthorized' }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Credentials changed');
  expect(screen.queryByText('Alice account')).toBeNull();
  let finish!: (value: unknown) => void;
  h.commercial.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Retry lead details' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(screen.queryByText('Alice account')).toBeNull();
  expect(screen.getByRole('combobox', { name: 'Download Lead work list' })).toBeDisabled();
  await act(async () => finish(await initial()));
  expect(await screen.findByText('Alice account')).toBeVisible();
});
