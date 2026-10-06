import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { emptyCommercialPlan } from '../../../shared/quotePackages';

const h = vi.hoisted(() => ({ request: vi.fn(), saveReport: vi.fn() }));
vi.mock('../lib/client', () => import('../../scripts/commercial-preview/fixtures'));
vi.mock('../lib/communications', () => ({ communicationRequest: h.request }));
vi.mock('../lib/reportDownload', async original => ({ ...await original<typeof import('../lib/reportDownload')>(), saveReport: h.saveReport }));
import { AdminContext } from '../lib/auth';
import AccountsList from './AccountsList';
import { AccountsListDataProvider } from '../lib/accountsListData';

const team = [
  { userId: 'alice', name: 'Alice', enabled: true, salesperson: true, available: true },
  { userId: 'bob', name: 'Bob', enabled: true, salesperson: true, available: true },
  { userId: 'disabled', name: 'Disabled salesperson', enabled: false, salesperson: true, available: true },
  { userId: 'staff', name: 'Office staff', enabled: true, salesperson: false, available: true },
  { userId: 'unavailable', name: 'Unavailable sign-in', enabled: true, salesperson: true, available: false },
  { userId: 'unchecked', name: 'Unchecked availability', enabled: true, salesperson: true },
];
let owner: string | undefined;
let version: number;
beforeEach(() => {
  vi.resetAllMocks();
  owner = 'alice'; version = 7;
  h.request.mockImplementation(async (operation, input) => {
    if (operation === 'team') return { team };
    if (operation === 'commercialTable') return { items: input.accountIds.map((accountId: string) => ({
      accountId, salespersonId: owner, workflowVersion: version, plan: emptyCommercialPlan(accountId),
    })) };
    if (operation === 'setResponsibilities') return { workflow: { accountId: input.accountId, salespersonId: input.salespersonId, version: input.version + 1 } };
    throw new Error(`Unexpected operation: ${operation}`);
  });
});

function Location() { return <output aria-label="Current route">{useLocation().pathname}</output>; }
function page(admin = true, stage: 'LEAD' | 'CLIENT' = 'LEAD') {
  return <AdminContext.Provider value={admin}><MemoryRouter initialEntries={['/leads']}><AccountsList stage={stage} /><Location /></MemoryRouter></AdminContext.Provider>;
}
async function willowPicker() { return screen.findByRole('combobox', { name: 'Salesperson for Willow Court Condominium' }); }

it.each(['focus', 'visibility', 'queued-focus'] as const)('keeps the assignment dropdown mounted across %s events until it loses focus', async trigger => {
  render(page());
  const picker = await willowPicker();
  const reads = () => h.request.mock.calls.filter(([op]) => op === 'commercialTable').length;
  const before = reads();
  // A native select can return window focus while its menu is still open.
  // Also cover a refresh queued just before the administrator opens it.
  if (trigger === 'queued-focus') fireEvent(window, new Event('focus'));
  act(() => picker.focus());
  fireEvent.click(picker);
  if (trigger === 'focus') fireEvent(window, new Event('focus'));
  if (trigger === 'visibility') fireEvent(document, new Event('visibilitychange'));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });

  expect(reads()).toBe(before);
  expect(await willowPicker()).toBe(picker);
  expect(picker).toHaveFocus();
  expect(picker).toBeEnabled();
  expect(screen.getByLabelText('Current route')).toHaveTextContent('/leads');
  // Escape/cancel must not save; leaving the control releases the refresh.
  fireEvent.keyDown(picker, { key: 'Escape' });
  act(() => picker.blur());
  await waitFor(() => expect(reads()).toBe(before + 1));
  expect(await willowPicker()).toHaveValue('alice');
  expect(h.request.mock.calls.some(([op]) => op === 'setResponsibilities')).toBe(false);
});

it('holds a return refresh through choosing and saving an owner, including blur during saving', async () => {
  const initial = h.request.getMockImplementation()!;
  let finishSave!: (value: unknown) => void;
  h.request.mockImplementation((op, input) => op === 'setResponsibilities'
    ? new Promise(resolve => { finishSave = resolve; }) : initial(op, input));
  render(page());
  const picker = await willowPicker();
  const reads = () => h.request.mock.calls.filter(([op]) => op === 'commercialTable').length;
  const before = reads();
  act(() => picker.focus());
  fireEvent(window, new Event('focus'));
  fireEvent.change(picker, { target: { value: 'bob' } });
  act(() => picker.blur());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
  expect(reads()).toBe(before);
  expect(await willowPicker()).toBe(picker);
  expect(picker).toBeDisabled();
  expect(h.request).toHaveBeenCalledWith('setResponsibilities', { accountId: 'willow', salespersonId: 'bob', version: 7 }, true);

  await act(async () => finishSave({ workflow: { accountId: 'willow', salespersonId: 'bob', version: 8 } }));
  await waitFor(() => expect(reads()).toBe(before + 1));
  // The background snapshot is deliberately older than the confirmed save.
  expect(await willowPicker()).toHaveValue('bob');
  expect(screen.getByLabelText('Current route')).toHaveTextContent('/leads');
});

it('saves inline without opening the lead and uses the returned version for the next edit', async () => {
  render(page());
  const picker = await willowPicker();
  expect(picker).toHaveValue('alice');
  expect(within(picker).queryByRole('option', { name: 'Disabled salesperson' })).not.toBeInTheDocument();
  expect(within(picker).queryByRole('option', { name: 'Office staff' })).not.toBeInTheDocument();
  expect(within(picker).queryByRole('option', { name: 'Unavailable sign-in' })).not.toBeInTheDocument();
  expect(within(picker).queryByRole('option', { name: 'Unchecked availability' })).not.toBeInTheDocument();
  fireEvent.click(picker);
  fireEvent.keyDown(picker, { key: 'ArrowDown' });
  fireEvent.change(picker, { target: { value: 'bob' } });
  await waitFor(() => expect(picker).toHaveValue('bob'));
  expect(await screen.findByText('Saved')).toBeInTheDocument();
  expect(h.request).toHaveBeenCalledWith('setResponsibilities', { accountId: 'willow', salespersonId: 'bob', version: 7 }, true);
  expect(screen.getByLabelText('Current route')).toHaveTextContent('/leads');

  fireEvent.change(screen.getByRole('combobox', { name: 'Download Leads' }), { target: { value: 'csv' } });
  const section = h.saveReport.mock.calls[0][0].sections[0];
  expect(section.rows.find((row: unknown[]) => row[0] === 'Willow Court Condominium')[section.columns.indexOf('Salesperson')]).toBe('Bob');

  fireEvent.change(picker, { target: { value: 'alice' } });
  await waitFor(() => expect(h.request).toHaveBeenCalledWith('setResponsibilities', { accountId: 'willow', salespersonId: 'alice', version: 8 }, true));
  await waitFor(() => expect(picker).toBeEnabled());
  fireEvent.click(screen.getByText('Willow Court Condominium'));
  expect(screen.getByLabelText('Current route')).toHaveTextContent('/accounts/willow');
});

it('keeps the old assignment on failure and can refresh a stale version before retrying', async () => {
  const initial = h.request.getMockImplementation()!;
  let rejectSave!: (reason: Error) => void;
  h.request.mockImplementation((op, input) => op === 'setResponsibilities' ? new Promise((_, reject) => { rejectSave = reject; }) : initial(op, input));
  render(page());
  const picker = await willowPicker();
  fireEvent.change(picker, { target: { value: 'bob' } });
  expect(picker).toBeDisabled();
  expect(screen.getByText('Saving…')).toBeInTheDocument();
  fireEvent.change(picker, { target: { value: 'alice' } });
  expect(h.request.mock.calls.filter(([op]) => op === 'setResponsibilities')).toHaveLength(1);
  await act(async () => rejectSave(new Error('This record changed. Refresh before saving.')));
  expect(picker).toHaveValue('alice');
  expect(picker).toBeEnabled();
  expect(screen.getByRole('alert')).toHaveTextContent('This record changed. Refresh before saving.');
  expect(screen.getByLabelText('Current route')).toHaveTextContent('/leads');

  version = 9;
  h.request.mockImplementation(initial);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh assignments' }));
  const refreshed = await willowPicker();
  fireEvent.change(refreshed, { target: { value: 'bob' } });
  await screen.findByText('Saved');
  expect(h.request).toHaveBeenCalledWith('setResponsibilities', { accountId: 'willow', salespersonId: 'bob', version: 9 }, true);
});

it('updates the active salesperson filter immediately after saving', async () => {
  render(page());
  const picker = await willowPicker();
  fireEvent.change(screen.getByRole('combobox', { name: 'Salesperson' }), { target: { value: 'alice' } });
  fireEvent.change(picker, { target: { value: 'bob' } });
  await waitFor(() => expect(screen.queryByText('Willow Court Condominium')).not.toBeInTheDocument());
  fireEvent.change(screen.getByRole('combobox', { name: 'Salesperson' }), { target: { value: 'bob' } });
  expect(await willowPicker()).toHaveValue('bob');
});

it.each(['refresh-last', 'save-last'])('keeps the newest assignment when another row refreshes during a save (%s)', async order => {
  const initial = h.request.getMockImplementation()!;
  let finishSave!: (value: unknown) => void;
  let finishRefresh!: (value: unknown) => void;
  let refreshing = false;
  h.request.mockImplementation((op, input) => {
    if (op === 'setResponsibilities') {
      if (input.accountId === 'pine') return Promise.reject(new Error('Refresh before saving.'));
      return new Promise(resolve => { finishSave = resolve; });
    }
    if (op === 'commercialTable' && refreshing) return new Promise(resolve => { finishRefresh = resolve; });
    return initial(op, input);
  });
  render(page());
  const willow = await willowPicker();
  fireEvent.change(screen.getByRole('combobox', { name: 'Salesperson for Pine Grove Association' }), { target: { value: 'bob' } });
  await screen.findByRole('alert');
  fireEvent.change(willow, { target: { value: 'bob' } });
  refreshing = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh assignments' }));
  await waitFor(() => expect(finishRefresh).toBeTypeOf('function'));
  const snapshot = await initial('commercialTable', { accountIds: ['willow', 'pine', 'cedar'] });
  const saved = { workflow: { accountId: 'willow', salespersonId: 'bob', version: 8 } };
  if (order === 'refresh-last') {
    await act(async () => finishSave(saved));
    await act(async () => finishRefresh(snapshot));
    expect(await willowPicker()).toHaveValue('bob');
  } else {
    snapshot.items[0].workflowVersion = 9;
    await act(async () => finishRefresh(snapshot));
    await act(async () => finishSave(saved));
    expect(await willowPicker()).toHaveValue('alice');
  }
  h.request.mockImplementation(initial);
  fireEvent.change(await willowPicker(), { target: { value: order === 'refresh-last' ? 'alice' : 'bob' } });
  await screen.findByText('Saved');
  expect(h.request).toHaveBeenLastCalledWith('setResponsibilities', { accountId: 'willow', salespersonId: order === 'refresh-last' ? 'alice' : 'bob', version: order === 'refresh-last' ? 8 : 9 }, true);
});

it.each(['disabled', 'unavailable'])('assigns a lead with no workflow and preserves an unavailable existing owner for correction (%s)', async unavailableId => {
  owner = undefined; version = 0;
  const view = render(page());
  const picker = await willowPicker();
  expect(picker).toHaveValue('');
  expect(within(picker).getByRole('option', { name: 'Unassigned' })).toBeDisabled();
  fireEvent.change(picker, { target: { value: 'bob' } });
  await screen.findByText('Saved');
  expect(h.request).toHaveBeenCalledWith('setResponsibilities', { accountId: 'willow', salespersonId: 'bob', version: 0 }, true);
  view.unmount();
  owner = unavailableId; version = 2;
  render(page());
  const unavailable = await willowPicker();
  expect(unavailable).toHaveValue(unavailableId);
  expect(within(unavailable).getByRole('option', { name: `${team.find(member => member.userId === unavailableId)!.name} (unavailable)` })).toBeDisabled();
  expect(unavailable).toBeEnabled();
});

it.each([false, true])('keeps non-admin leads and admin client rows free of assignment controls (admin=%s)', async admin => {
  render(page(admin, admin ? 'CLIENT' : 'LEAD'));
  await waitFor(() => expect(h.request).toHaveBeenCalledWith('commercialTable', expect.anything()));
  await screen.findByText(admin ? 'Cedar House — partially bound' : 'Willow Court Condominium');
  expect(screen.queryByRole('combobox', { name: /^Salesperson for / })).not.toBeInTheDocument();
  expect(h.request.mock.calls.some(([op]) => op === 'setResponsibilities')).toBe(false);
});


it.each(['LEAD', 'CLIENT'] as const)('lists only configured producers in the %s filter, including inactive producers', async stage => {
  // A staff member can own an old record without being a producer. The user's
  // producer-only filter must not turn into a second full team roster.
  owner = 'staff';
  render(page(true, stage));
  await screen.findByText(stage === 'LEAD' ? 'Willow Court Condominium' : 'Cedar House — partially bound');
  const filter = within(screen.getByRole('combobox', { name: 'Salesperson' }));
  expect(filter.getAllByRole('option').map(option => option.textContent)).toEqual([
    'All salespeople', 'Alice', 'Bob', 'Disabled salesperson', 'Unavailable sign-in', 'Unchecked availability',
  ]);
  expect(filter.queryByRole('option', { name: 'Office staff' })).not.toBeInTheDocument();
});

it('keeps the saved list and controls visible while revalidating on return, and supports explicit refresh', async () => {
  render(<AdminContext.Provider value={true}><AccountsListDataProvider><MemoryRouter initialEntries={['/leads']}>
    <Routes>
      <Route path="/leads" element={<AccountsList stage="LEAD" />} />
      <Route path="/accounts/:id" element={<Link to="/leads">Back to leads</Link>} />
    </Routes>
  </MemoryRouter></AccountsListDataProvider></AdminContext.Provider>);
  const picker = await willowPicker();
  fireEvent.change(picker, { target: { value: 'bob' } });
  await waitFor(() => expect(picker).toHaveValue('bob'));
  await screen.findByText('Saved');
  fireEvent.click(screen.getByText('Willow Court Condominium'));
  const initial = h.request.getMockImplementation()!;
  const readsBefore = h.request.mock.calls.filter(([op]) => op === 'commercialTable').length;
  let finishRefresh!: (value: unknown) => void;
  h.request.mockImplementation((op, input) => op === 'commercialTable'
    ? new Promise(resolve => { finishRefresh = resolve; }) : initial(op, input));
  fireEvent.click(screen.getByRole('link', { name: 'Back to leads' }));
  const cached = screen.getByRole('combobox', { name: 'Salesperson for Willow Court Condominium' });
  expect(cached).toHaveValue('bob');
  expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  await waitFor(() => expect(finishRefresh).toBeTypeOf('function'));
  expect(h.request.mock.calls.filter(([op]) => op === 'commercialTable')).toHaveLength(readsBefore + 1);
  expect(screen.getByRole('button', { name: 'Refresh leads' })).toBeDisabled();
  expect(screen.getByRole('combobox', { name: 'Download Leads' })).toBeDisabled();
  expect(cached).toBeEnabled();
  // A response from before the save must not undo the confirmed assignment.
  await act(async () => finishRefresh(await initial('commercialTable', { accountIds: ['willow', 'pine', 'cedar'] })));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh leads' })).toBeEnabled());
  expect(await willowPicker()).toBe(cached);
  expect(cached).toHaveValue('bob');
  h.request.mockImplementation(initial);
  version = 9;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh leads' }));
  await waitFor(() => expect(cached).toHaveValue('alice'));
  expect(h.request.mock.calls.filter(([op]) => op === 'commercialTable')).toHaveLength(readsBefore + 2);
});

it.each(['LEAD', 'CLIENT'] as const)('keeps the %s table on transient refresh failure, warns, and disables stale exports until retry succeeds', async stage => {
  render(page(true, stage));
  await screen.findByText(stage === 'LEAD' ? 'Willow Court Condominium' : 'Cedar House — partially bound');
  const table = screen.getByRole('table');
  const original = h.request.getMockImplementation()!;
  h.request.mockImplementation((op, input) => op === 'commercialTable' ? Promise.reject(new Error('Temporary details outage')) : original(op, input));
  fireEvent.click(screen.getByRole('button', { name: stage === 'LEAD' ? 'Refresh leads' : 'Refresh clients' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Some details may be out of date.');
  expect(screen.getByRole('table')).toBe(table);
  expect(screen.getByRole('combobox', { name: `Download ${stage === 'LEAD' ? 'Leads' : 'Clients'}` })).toBeDisabled();
  h.request.mockImplementation(original);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(screen.getByRole('combobox', { name: `Download ${stage === 'LEAD' ? 'Leads' : 'Clients'}` })).toBeEnabled();
  expect(screen.getByRole('table')).toBe(table);
});

it('clears a selected filter when that teammate is no longer a configured producer', async () => {
  render(page());
  await willowPicker();
  fireEvent.change(screen.getByRole('combobox', { name: 'Salesperson' }), { target: { value: 'alice' } });
  const original = h.request.getMockImplementation()!;
  h.request.mockImplementation((op, input) => op === 'team'
    ? { team: team.map(teammate => teammate.userId === 'alice' ? { ...teammate, salesperson: false } : teammate) }
    : original(op, input));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh leads' }));
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Salesperson' })).toHaveValue(''));
  expect(within(screen.getByRole('combobox', { name: 'Salesperson' })).queryByRole('option', { name: 'Alice' })).not.toBeInTheDocument();
  expect(screen.getByText('Willow Court Condominium')).toBeInTheDocument();
});

it('keeps rows and assignment controls visible throughout a background refresh', async () => {
  render(page());
  const picker = await willowPicker();
  const table = screen.getByRole('table');
  const initial = h.request.getMockImplementation()!;
  let finishRefresh!: (value: unknown) => void;
  h.request.mockImplementation((op, input) => op === 'commercialTable'
    ? new Promise(resolve => { finishRefresh = resolve; }) : initial(op, input));
  fireEvent(window, new Event('focus'));
  await waitFor(() => expect(finishRefresh).toBeTypeOf('function'));
  expect(screen.getByRole('table')).toBe(table);
  expect(await willowPicker()).toBe(picker);
  expect(picker).toBeEnabled();
  expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  owner = 'bob'; version = 8;
  await act(async () => finishRefresh(await initial('commercialTable', { accountIds: ['willow', 'pine', 'cedar'] })));
  expect(await willowPicker()).toBe(picker);
  expect(picker).toHaveValue('bob');
});
