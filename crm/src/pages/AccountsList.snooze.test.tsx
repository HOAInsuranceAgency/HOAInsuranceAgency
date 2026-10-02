import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { emptyLeadSnooze, type LeadSnooze } from '../../../shared/leadSnooze';
import { emptyCommercialPlan } from '../../../shared/quotePackages';

const h = vi.hoisted(() => ({ request: vi.fn(), saveReport: vi.fn(), listAccounts: vi.fn() }));
vi.mock('../lib/client', async () => {
  const fixtures = await import('../../scripts/commercial-preview/fixtures');
  return { ...fixtures, client: { ...fixtures.client, models: { ...fixtures.client.models, Account: { list: h.listAccounts } } } };
});
vi.mock('../lib/communications', () => ({ communicationRequest: h.request }));
vi.mock('../lib/reportDownload', async original => ({ ...await original<typeof import('../lib/reportDownload')>(), saveReport: h.saveReport }));
import { accounts, plans } from '../../scripts/commercial-preview/fixtures';
import { AdminContext } from '../lib/auth';
import AccountsList from './AccountsList';

const willow = 'Willow Court Condominium';
const pine = 'Pine Grove Association';
const cedar = 'Cedar House — partially bound';
let snoozes: Record<string, LeadSnooze>;
let currentAccounts: typeof accounts;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-10-01T16:00:00Z');
  snoozes = Object.fromEntries(['willow', 'pine', 'cedar'].map(id => [id, emptyLeadSnooze(id)]));
  currentAccounts = structuredClone(accounts);
  h.listAccounts.mockImplementation(async () => ({ data: structuredClone(currentAccounts) }));
  h.request.mockImplementation(async (operation, input) => {
    if (operation === 'team') return { team: [{ userId: 'sales', name: 'Avery Brooks', enabled: true, salesperson: true }] };
    if (operation === 'commercialTable') return { items: input.accountIds.map((accountId: string) => ({
      accountId, salespersonId: 'sales', plan: structuredClone(plans[accountId] ?? emptyCommercialPlan(accountId)),
      ...(input.snoozeAccountIds?.includes(accountId) ? { snooze: { ...(snoozes[accountId] ?? emptyLeadSnooze(accountId)) } } : {}),
    })) };
    if (operation === 'saveLeadSnooze') {
      const snooze = { accountId: input.accountId, version: input.version + 1, followUpOn: input.followUpOn, note: input.note };
      snoozes[input.accountId] = snooze;
      return { snooze };
    }
    throw new Error(`Unexpected operation: ${operation}`);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function Location() { return <output aria-label="Current route">{useLocation().pathname}</output>; }
function page(stage: 'LEAD' | 'CLIENT' = 'LEAD', admin = false) {
  return <AdminContext.Provider value={admin}><MemoryRouter initialEntries={[stage === 'LEAD' ? '/leads' : '/clients']}>
    <AccountsList stage={stage} /><Location />
  </MemoryRouter></AdminContext.Provider>;
}
function row(name: string) { return within(screen.getByText(name).closest('tr')!); }
function chooseView(name: string) { fireEvent.click(within(screen.getByRole('tablist', { name: 'Lead views' })).getByRole('tab', { name })); }
function fillFollowUp(name: string, date: string, note = '') {
  const scope = row(name);
  fireEvent.change(scope.getByLabelText('Follow-up date'), { target: { value: date } });
  fireEvent.change(scope.getByLabelText('Follow-up note'), { target: { value: note } });
  fireEvent.click(scope.getByRole('button', { name: 'Snooze lead' }));
}
function returnToPage(trigger: 'focus' | 'visibility' | 'both' = 'both') {
  if (trigger !== 'visibility') window.dispatchEvent(new Event('focus'));
  if (trigger !== 'focus') document.dispatchEvent(new Event('visibilitychange'));
}
async function allowReturnRefresh() {
  // The hook coalesces browser focus/visibility events for 100 ms.
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 150)); });
}

it('lets an owned producer snooze, find, export, and bring back a lead without navigating', async () => {
  render(page());
  fireEvent.click(await screen.findByRole('button', { name: `Snooze ${willow}` }));
  expect(screen.queryByRole('combobox', { name: 'Salesperson' })).not.toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Active' })).toHaveAttribute('aria-selected', 'true');
  fillFollowUp(willow, '2026-10-09', '  Check with the board  ');
  await waitFor(() => expect(screen.queryByText(willow)).not.toBeInTheDocument());
  expect(h.request).toHaveBeenCalledWith('saveLeadSnooze', {
    accountId: 'willow', version: 0, followUpOn: '2026-10-09', note: 'Check with the board',
  }, true);
  expect(screen.getByLabelText('Current route')).toHaveTextContent('/leads');

  chooseView('Snoozed');
  expect(await screen.findByText(willow)).toBeInTheDocument();
  expect(row(willow).getByText('Check with the board')).toBeInTheDocument();
  expect(row(willow).getByRole('button', { name: `Edit follow-up for ${willow}` })).toBeInTheDocument();
  expect(screen.queryByText(pine)).not.toBeInTheDocument();
  expect(screen.queryByText(cedar)).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: 'Download Leads' }), { target: { value: 'csv' } });
  const report = h.saveReport.mock.calls[0][0];
  expect(report.sections[0].rows.map((cells: unknown[]) => cells[0])).toEqual([willow]);
  expect(report.sections[0].columns).not.toContain('Salesperson');

  fireEvent.click(row(willow).getByRole('button', { name: 'Bring back now' }));
  await waitFor(() => expect(screen.queryByText(willow)).not.toBeInTheDocument());
  expect(h.request).toHaveBeenLastCalledWith('saveLeadSnooze', { accountId: 'willow', version: 1, followUpOn: null, note: '' }, true);
  chooseView('Active');
  expect(await screen.findByRole('button', { name: `Snooze ${willow}` })).toBeInTheDocument();
});

it('hides future follow-ups by default and keeps binding clients visible without snooze controls', async () => {
  snoozes.pine = { accountId: 'pine', version: 2, followUpOn: '2026-10-09', note: 'Waiting for board meeting' };
  // A previously snoozed lead may already have become a client.
  snoozes.cedar = { accountId: 'cedar', version: 3, followUpOn: '2026-10-10', note: 'Old lead follow-up' };
  render(page());
  await screen.findByRole('button', { name: `Snooze ${willow}` });
  expect(screen.queryByText(pine)).not.toBeInTheDocument();
  expect(screen.getByText(cedar)).toBeInTheDocument();
  expect(row(cedar).queryByRole('button', { name: /Snooze|Edit follow-up|Bring back now|Mark followed up/ })).not.toBeInTheDocument();
  chooseView('Snoozed');
  expect(screen.getByText(pine)).toBeInTheDocument();
  expect(screen.queryByText(cedar)).not.toBeInTheDocument();
  chooseView('All leads');
  expect(screen.getByText(willow)).toBeInTheDocument();
  expect(screen.getByText(pine)).toBeInTheDocument();
  expect(screen.getByText(cedar)).toBeInTheDocument();
});

it('keeps today and overdue follow-ups active until they are marked followed up', async () => {
  snoozes.willow = { accountId: 'willow', version: 4, followUpOn: '2026-10-01', note: 'Call today' };
  snoozes.pine = { accountId: 'pine', version: 2, followUpOn: '2026-09-30', note: 'Missed yesterday' };
  render(page());
  await screen.findByRole('button', { name: `Edit follow-up for ${willow}` });
  expect(screen.getByText(pine)).toBeInTheDocument();
  chooseView('Follow-up due');
  expect(screen.getByText(willow)).toBeInTheDocument();
  expect(screen.getByText(pine)).toBeInTheDocument();
  expect(screen.queryByText(cedar)).not.toBeInTheDocument();
  fireEvent.click(row(willow).getByRole('button', { name: 'Mark followed up' }));
  await waitFor(() => expect(screen.queryByText(willow)).not.toBeInTheDocument());
  expect(h.request).toHaveBeenLastCalledWith('saveLeadSnooze', { accountId: 'willow', version: 4, followUpOn: null, note: '' }, true);
  chooseView('Active');
  expect(await screen.findByRole('button', { name: `Snooze ${willow}` })).toBeInTheDocument();
  expect(row(willow).queryByText('Call today')).not.toBeInTheDocument();
});

it.each(['interval', 'visibility'] as const)('resurfaces a lead at Eastern midnight on %s', async trigger => {
  if (trigger === 'interval') vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime('2026-10-02T03:59:50Z'); // October 1 at 11:59 p.m. Eastern; already October 2 in UTC.
  snoozes.willow = { accountId: 'willow', version: 1, followUpOn: '2026-10-02', note: 'Call tomorrow' };
  render(page());
  await screen.findByRole('button', { name: `Snooze ${pine}` });
  expect(screen.queryByText(willow)).not.toBeInTheDocument();
  const readsBeforeMidnight = h.request.mock.calls.filter(([op]) => op === 'commercialTable').length;

  await act(async () => {
    vi.setSystemTime('2026-10-02T04:00:01Z');
    if (trigger === 'interval') await vi.advanceTimersByTimeAsync(30_000);
    else document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(screen.getByRole('button', { name: `Edit follow-up for ${willow}` })).toBeInTheDocument();
  expect(row(willow).getByRole('button', { name: 'Mark followed up' })).toBeInTheDocument();
  if (trigger === 'interval') expect(h.request.mock.calls.filter(([op]) => op === 'commercialTable')).toHaveLength(readsBeforeMidnight);
  else {
    await allowReturnRefresh();
    expect(h.request.mock.calls.filter(([op]) => op === 'commercialTable')).toHaveLength(readsBeforeMidnight + 1);
    expect(row(willow).getByRole('button', { name: 'Mark followed up' })).toBeInTheDocument();
  }
});

it('preserves the saved date after failure and refreshes the version before retrying', async () => {
  snoozes.willow = { accountId: 'willow', version: 4, followUpOn: '2026-10-09', note: 'Original note' };
  const initial = h.request.getMockImplementation()!;
  let rejectSave!: (error: Error) => void;
  h.request.mockImplementation((op, input) => op === 'saveLeadSnooze'
    ? new Promise((_, reject) => { rejectSave = reject; }) : initial(op, input));
  render(page());
  await screen.findByRole('button', { name: `Snooze ${pine}` });
  chooseView('Snoozed');
  fireEvent.click(row(willow).getByRole('button', { name: `Edit follow-up for ${willow}` }));
  fillFollowUp(willow, '2026-10-12', 'Revised note');
  expect(row(willow).getByRole('button', { name: 'Snooze lead' })).toBeDisabled();
  expect(row(willow).getByLabelText('Follow-up date')).toBeDisabled();
  await act(async () => rejectSave(new Error('This follow-up changed. Refresh before saving.')));
  expect(screen.getByRole('alert')).toHaveTextContent('This follow-up changed. Refresh before saving.');
  expect(row(willow).getByText('Original note')).toBeInTheDocument();
  expect(row(willow).getByLabelText('Follow-up date')).toHaveValue('2026-10-12');
  expect(screen.getByLabelText('Current route')).toHaveTextContent('/leads');

  snoozes.willow = { accountId: 'willow', version: 5, followUpOn: '2026-10-10', note: 'Updated elsewhere' };
  h.request.mockImplementation(initial);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  fireEvent.click(await screen.findByRole('button', { name: `Edit follow-up for ${willow}` }));
  expect(row(willow).getByLabelText('Follow-up date')).toHaveValue('2026-10-10');
  fillFollowUp(willow, '2026-10-12', 'Revised note');
  await waitFor(() => expect(row(willow).queryByLabelText('Follow-up date')).not.toBeInTheDocument());
  expect(h.request).toHaveBeenLastCalledWith('saveLeadSnooze', { accountId: 'willow', version: 5, followUpOn: '2026-10-12', note: 'Revised note' }, true);
});

it.each(['refresh-last', 'save-last'] as const)('keeps the newest confirmed follow-up when a different row refreshes during saving (%s)', async order => {
  snoozes.willow.version = 7;
  const initial = h.request.getMockImplementation()!;
  let finishSave!: (value: unknown) => void;
  let finishRefresh!: (value: unknown) => void;
  let refreshing = false;
  h.request.mockImplementation((op, input) => {
    if (op === 'saveLeadSnooze') {
      if (input.accountId === 'pine') return Promise.reject(new Error('Refresh before saving.'));
      return new Promise(resolve => { finishSave = resolve; });
    }
    if (op === 'commercialTable' && refreshing) return new Promise(resolve => { finishRefresh = resolve; });
    return initial(op, input);
  });
  render(page());
  await screen.findByRole('button', { name: `Snooze ${willow}` });
  chooseView('All leads');
  fireEvent.click(row(pine).getByRole('button', { name: `Snooze ${pine}` }));
  fillFollowUp(pine, '2026-10-09');
  await screen.findByRole('alert');
  fireEvent.click(row(willow).getByRole('button', { name: `Snooze ${willow}` }));
  fillFollowUp(willow, '2026-10-09', 'Saved follow-up');
  refreshing = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(finishRefresh).toBeTypeOf('function'));
  const snapshot = await initial('commercialTable', { accountIds: ['willow', 'pine', 'cedar'], snoozeAccountIds: ['willow', 'pine'] });
  const saved = { snooze: { accountId: 'willow', version: 8, followUpOn: '2026-10-09', note: 'Saved follow-up' } };
  if (order === 'refresh-last') {
    await act(async () => finishSave(saved));
    await act(async () => finishRefresh(snapshot));
    chooseView('Snoozed');
    expect(screen.getByText(willow)).toBeInTheDocument();
    expect(row(willow).getByText('Saved follow-up')).toBeInTheDocument();
  } else {
    snapshot.items[0].snooze.version = 9;
    await act(async () => finishRefresh(snapshot));
    await act(async () => finishSave(saved));
    chooseView('Snoozed');
    expect(screen.queryByText(willow)).not.toBeInTheDocument();
    chooseView('Active');
    expect(screen.getByRole('button', { name: `Snooze ${willow}` })).toBeInTheDocument();
  }
  h.request.mockImplementation(initial);
  fireEvent.click(row(willow).getByRole('button', { name: order === 'refresh-last' ? `Edit follow-up for ${willow}` : `Snooze ${willow}` }));
  fillFollowUp(willow, '2026-10-12');
  await waitFor(() => expect(h.request).toHaveBeenLastCalledWith('saveLeadSnooze', {
    accountId: 'willow', version: order === 'refresh-last' ? 8 : 9, followUpOn: '2026-10-12', note: '',
  }, true));
});

it('cancels a draft without saving and leaves Clients free of follow-up controls', async () => {
  const view = render(page());
  fireEvent.click(await screen.findByRole('button', { name: `Snooze ${willow}` }));
  fireEvent.change(row(willow).getByLabelText('Follow-up note'), { target: { value: 'Unsaved note' } });
  fireEvent.click(row(willow).getByRole('button', { name: 'Cancel' }));
  expect(row(willow).getByRole('button', { name: `Snooze ${willow}` })).toBeInTheDocument();
  expect(h.request.mock.calls.some(([op]) => op === 'saveLeadSnooze')).toBe(false);
  view.unmount();
  render(page('CLIENT'));
  await screen.findByText(cedar);
  expect(screen.queryByRole('tablist', { name: 'Lead views' })).not.toBeInTheDocument();
  expect(screen.queryByRole('columnheader', { name: 'Follow-up' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Snooze|Edit follow-up|Bring back now|Mark followed up/ })).not.toBeInTheDocument();
  const clientRead = h.request.mock.calls.filter(([op]) => op === 'commercialTable').at(-1)![1];
  expect(clientRead).not.toHaveProperty('snoozeAccountIds');
});

it.each(['focus', 'visibility'] as const)('refreshes changed follow-ups and the accessible account list on %s', async trigger => {
  snoozes.willow = { accountId: 'willow', version: 1, followUpOn: '2026-10-09', note: 'Waiting' };
  render(page());
  await screen.findByRole('button', { name: `Snooze ${pine}` });
  expect(screen.queryByText(willow)).not.toBeInTheDocument();
  expect(screen.getByText(cedar)).toBeInTheDocument();
  expect(h.request).toHaveBeenCalledWith('commercialTable', { accountIds: ['cedar', 'pine', 'willow'], snoozeAccountIds: ['pine', 'willow'] });

  snoozes.willow = { accountId: 'willow', version: 2, followUpOn: null, note: '' };
  snoozes.pine = { accountId: 'pine', version: 1, followUpOn: '2026-10-10', note: 'Snoozed in another window' };
  currentAccounts = [...currentAccounts.filter(account => account.id !== 'cedar'), { ...currentAccounts[0], id: 'maple', name: 'Maple Association' }];
  act(() => returnToPage(trigger));
  expect(await screen.findByRole('button', { name: `Snooze ${willow}` })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Snooze Maple Association' })).toBeInTheDocument();
  expect(screen.queryByText(cedar)).not.toBeInTheDocument();
  expect(screen.queryByText(pine)).not.toBeInTheDocument();
  expect(h.listAccounts).toHaveBeenCalledTimes(2);
  expect(h.request).toHaveBeenLastCalledWith('commercialTable', { accountIds: ['maple', 'pine', 'willow'], snoozeAccountIds: ['maple', 'pine', 'willow'] });
  chooseView('Snoozed');
  expect(row(pine).getByText('Snoozed in another window')).toBeInTheDocument();
});

it('ignores hidden-page events and coalesces the paired focus and visible events into one refresh', async () => {
  render(page());
  await screen.findByRole('button', { name: `Snooze ${willow}` });
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  act(() => returnToPage());
  await allowReturnRefresh();
  expect(h.listAccounts).toHaveBeenCalledTimes(1);
  visibility.mockReturnValue('visible');
  act(() => returnToPage());
  await allowReturnRefresh();
  expect(h.listAccounts).toHaveBeenCalledTimes(2);
  expect(h.request.mock.calls.filter(([op]) => op === 'commercialTable')).toHaveLength(2);
});

it.each(['snooze', 'estimate'] as const)('preserves the %s draft across return events and refreshes once editing ends', async editor => {
  render(page());
  await screen.findByRole('button', { name: `Snooze ${willow}` });
  if (editor === 'snooze') {
    fireEvent.click(row(willow).getByRole('button', { name: `Snooze ${willow}` }));
    fireEvent.change(row(willow).getByLabelText('Follow-up date'), { target: { value: '2026-10-12' } });
    fireEvent.change(row(willow).getByLabelText('Follow-up note'), { target: { value: 'Do not lose this draft' } });
  } else {
    fireEvent.click(row(willow).getByRole('button', { name: 'Edit estimated opportunity' }));
    fireEvent.change(row(willow).getByLabelText('Estimated agency commission'), { target: { value: '2375.50' } });
  }
  act(() => returnToPage());
  await allowReturnRefresh();
  expect(h.listAccounts).toHaveBeenCalledTimes(1);
  if (editor === 'snooze') {
    expect(row(willow).getByLabelText('Follow-up date')).toHaveValue('2026-10-12');
    expect(row(willow).getByLabelText('Follow-up note')).toHaveValue('Do not lose this draft');
  } else expect(row(willow).getByLabelText('Estimated agency commission')).toHaveValue('2375.50');
  fireEvent.click(row(willow).getByRole('button', { name: 'Cancel' }));
  await allowReturnRefresh();
  expect(h.listAccounts).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: `Snooze ${willow}` })).toBeInTheDocument();
  expect(h.request.mock.calls.some(([op]) => op === 'saveLeadSnooze' || op === 'saveCommercial')).toBe(false);
});

it.each(['snooze', 'clear'] as const)('defers refresh until the %s save finishes and retains the confirmed version over the stale read', async action => {
  if (action === 'clear') snoozes.willow = { accountId: 'willow', version: 2, followUpOn: '2026-10-09', note: 'Old note' };
  const initial = h.request.getMockImplementation()!;
  let finishSave!: (value: unknown) => void;
  h.request.mockImplementation((op, input) => op === 'saveLeadSnooze' ? new Promise(resolve => { finishSave = resolve; }) : initial(op, input));
  render(page());
  await screen.findByRole('button', { name: `Snooze ${pine}` });
  chooseView('All leads');
  if (action === 'snooze') {
    fireEvent.click(row(willow).getByRole('button', { name: `Snooze ${willow}` }));
    fillFollowUp(willow, '2026-10-09', 'Confirmed follow-up');
  } else fireEvent.click(row(willow).getByRole('button', { name: 'Bring back now' }));
  act(() => returnToPage());
  await allowReturnRefresh();
  expect(h.listAccounts).toHaveBeenCalledTimes(1);
  expect(row(willow).getByRole('status')).toHaveTextContent('Saving…');

  await act(async () => finishSave({ snooze: {
    accountId: 'willow', version: action === 'snooze' ? 1 : 3,
    followUpOn: action === 'snooze' ? '2026-10-09' : null,
    note: action === 'snooze' ? 'Confirmed follow-up' : '',
  } }));
  await allowReturnRefresh();
  expect(h.listAccounts).toHaveBeenCalledTimes(2);
  chooseView(action === 'snooze' ? 'Snoozed' : 'Active');
  expect(screen.getByText(willow)).toBeInTheDocument();
  expect(row(willow).getByRole('button', { name: action === 'snooze' ? `Edit follow-up for ${willow}` : `Snooze ${willow}` })).toBeInTheDocument();
});

it('waits for an estimated opportunity save before refreshing', async () => {
  const initial = h.request.getMockImplementation()!;
  let finishSave!: (value: unknown) => void;
  h.request.mockImplementation((op, input) => op === 'saveCommercial' ? new Promise(resolve => { finishSave = resolve; }) : initial(op, input));
  render(page());
  await screen.findByRole('button', { name: `Snooze ${willow}` });
  fireEvent.click(row(willow).getByRole('button', { name: 'Edit estimated opportunity' }));
  fireEvent.change(row(willow).getByLabelText('Estimated agency commission'), { target: { value: '2400' } });
  fireEvent.click(row(willow).getByRole('button', { name: 'Save' }));
  act(() => returnToPage());
  await allowReturnRefresh();
  expect(h.listAccounts).toHaveBeenCalledTimes(1);
  expect(row(willow).getByLabelText('Estimated agency commission')).toBeDisabled();
  await act(async () => finishSave({ plan: { ...plans.willow, version: 2, estimatedCents: 240000 } }));
  await allowReturnRefresh();
  expect(h.listAccounts).toHaveBeenCalledTimes(2);
  expect(row(willow).queryByLabelText('Estimated agency commission')).not.toBeInTheDocument();
});

it('defers return refresh while an admin changes a snoozed lead owner and retains the saved assignment', async () => {
  snoozes.willow = { accountId: 'willow', version: 2, followUpOn: '2026-10-09', note: 'Waiting for the board' };
  const initial = h.request.getMockImplementation()!;
  let finishAssignment!: (value: unknown) => void;
  let assignmentRequests = 0;
  h.request.mockImplementation(async (operation, input) => {
    if (operation === 'team') return { team: [
      { userId: 'alice', name: 'Alice', enabled: true, salesperson: true, available: true },
      { userId: 'bob', name: 'Bob', enabled: true, salesperson: true, available: true },
    ] };
    if (operation === 'commercialTable') {
      const result = await initial(operation, input);
      // The returned snapshot intentionally predates the successful save.
      return { items: result.items.map((item: Record<string, unknown>) => ({ ...item, salespersonId: 'alice', workflowVersion: 7 })) };
    }
    if (operation === 'setResponsibilities') {
      if (++assignmentRequests === 1) return new Promise(resolve => { finishAssignment = resolve; });
      return { workflow: { accountId: input.accountId, salespersonId: input.salespersonId, version: input.version + 1 } };
    }
    return initial(operation, input);
  });
  render(page('LEAD', true));
  await screen.findByRole('button', { name: `Snooze ${pine}` });
  chooseView('Snoozed');
  const picker = screen.getByRole('combobox', { name: `Salesperson for ${willow}` });
  fireEvent.change(picker, { target: { value: 'bob' } });
  act(() => returnToPage());
  await allowReturnRefresh();
  expect(h.listAccounts).toHaveBeenCalledTimes(1);
  expect(h.request.mock.calls.filter(([operation]) => operation === 'commercialTable')).toHaveLength(1);
  expect(screen.getByRole('combobox', { name: `Salesperson for ${willow}` })).toBe(picker);
  expect(picker).toBeDisabled();
  expect(picker).toHaveValue('bob');
  expect(row(willow).getByRole('status')).toHaveTextContent('Saving…');
  expect(screen.getByLabelText('Current route')).toHaveTextContent('/leads');

  await act(async () => finishAssignment({ workflow: { accountId: 'willow', salespersonId: 'bob', version: 8 } }));
  await allowReturnRefresh();
  expect(h.listAccounts).toHaveBeenCalledTimes(2);
  expect(h.request.mock.calls.filter(([operation]) => operation === 'commercialTable')).toHaveLength(2);
  expect(screen.getByRole('tab', { name: 'Snoozed' })).toHaveAttribute('aria-selected', 'true');
  const refreshedPicker = screen.getByRole('combobox', { name: `Salesperson for ${willow}` });
  expect(refreshedPicker).toBeEnabled();
  expect(refreshedPicker).toHaveValue('bob');
  expect(row(willow).getByText('Waiting for the board')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: 'Salesperson' }), { target: { value: 'bob' } });
  expect(screen.getByText(willow)).toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: 'Download Leads' }), { target: { value: 'csv' } });
  const section = h.saveReport.mock.calls[0][0].sections[0];
  expect(section.rows[0][section.columns.indexOf('Salesperson')]).toBe('Bob');
  fireEvent.change(refreshedPicker, { target: { value: 'alice' } });
  await waitFor(() => expect(h.request).toHaveBeenCalledWith('setResponsibilities', { accountId: 'willow', salespersonId: 'alice', version: 8 }, true));
});
