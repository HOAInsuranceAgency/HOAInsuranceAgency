import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { emptyCommercialPlan } from '../../../shared/quotePackages';

const h = vi.hoisted(() => ({ request: vi.fn(), saveReport: vi.fn() }));
vi.mock('../lib/client', () => import('../../scripts/commercial-preview/fixtures'));
vi.mock('../lib/communications', () => ({ communicationRequest: h.request }));
vi.mock('../lib/reportDownload', async original => ({ ...await original<typeof import('../lib/reportDownload')>(), saveReport: h.saveReport }));
import { AdminContext } from '../lib/auth';
import AccountsList from './AccountsList';

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
