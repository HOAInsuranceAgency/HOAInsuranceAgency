import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { emptyLeadSnooze, type LeadSnooze } from '../../../shared/leadSnooze';

const h = vi.hoisted(() => ({ request: vi.fn(), saveReport: vi.fn() }));
vi.mock('../lib/client', () => import('../../scripts/commercial-preview/fixtures'));
vi.mock('../lib/communications', () => ({ communicationRequest: h.request }));
vi.mock('../lib/reportDownload', async original => ({ ...await original<typeof import('../lib/reportDownload')>(), saveReport: h.saveReport }));
import { plans } from '../../scripts/commercial-preview/fixtures';
import { AdminContext } from '../lib/auth';
import AccountsList from './AccountsList';

const willow = 'Willow Court Condominium';
const pine = 'Pine Grove Association';
const cedar = 'Cedar House — partially bound';
let snoozes: Record<string, LeadSnooze>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-10-01T16:00:00Z');
  snoozes = Object.fromEntries(['willow', 'pine', 'cedar'].map(id => [id, emptyLeadSnooze(id)]));
  h.request.mockImplementation(async (operation, input) => {
    if (operation === 'team') return { team: [{ userId: 'sales', name: 'Avery Brooks', enabled: true, salesperson: true }] };
    if (operation === 'commercialTable') return { items: input.accountIds.map((accountId: string) => ({
      accountId, salespersonId: 'sales', plan: structuredClone(plans[accountId]), snooze: { ...snoozes[accountId] },
    })) };
    if (operation === 'saveLeadSnooze') {
      const snooze = { accountId: input.accountId, version: input.version + 1, followUpOn: input.followUpOn, note: input.note };
      snoozes[input.accountId] = snooze;
      return { snooze };
    }
    throw new Error(`Unexpected operation: ${operation}`);
  });
});
afterEach(() => vi.useRealTimers());

function Location() { return <output aria-label="Current route">{useLocation().pathname}</output>; }
function page(stage: 'LEAD' | 'CLIENT' = 'LEAD') {
  return <AdminContext.Provider value={false}><MemoryRouter initialEntries={[stage === 'LEAD' ? '/leads' : '/clients']}>
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

it.each(['interval', 'visibility'] as const)('resurfaces a lead at Eastern midnight on %s without reloading', async trigger => {
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
  expect(h.request.mock.calls.filter(([op]) => op === 'commercialTable')).toHaveLength(readsBeforeMidnight);
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
  const snapshot = await initial('commercialTable', { accountIds: ['willow', 'pine', 'cedar'] });
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
});
