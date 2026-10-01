import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { emptyLeadSnooze } from '../../../shared/leadSnooze';

const request = vi.hoisted(() => vi.fn());
vi.mock('../lib/communications', () => ({ communicationRequest: request }));
vi.mock('../lib/client', () => import('../../scripts/commercial-preview/fixtures'));
vi.mock('./CommunicationAccountSummary', () => ({ default: () => null }));
import LeadWorkflowPanel from './LeadWorkflowPanel';

beforeEach(() => {
  request.mockReset();
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime('2026-10-01T16:00:00Z');
});
afterEach(() => vi.useRealTimers());

it('keeps a snooze draft when an already-running background refresh fails', async () => {
  let failRefresh!: (error: Error) => void;
  request.mockResolvedValueOnce({ workflow: { accountId: 'a', name: 'Example lead', version: 1, disposition: 'ACTIVE', humanTakeover: true }, snooze: emptyLeadSnooze('a'), tasks: [], communications: [], team: [], issues: [] });
  request.mockImplementationOnce(() => new Promise((_resolve, reject) => { failRefresh = reject; }));
  render(<LeadWorkflowPanel accountId="a" onOpen={vi.fn()} />);
  await screen.findByRole('button', { name: 'Snooze Example lead' });
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  fireEvent.click(screen.getByRole('button', { name: 'Snooze Example lead' }));
  fireEvent.change(screen.getByLabelText('Follow-up note'), { target: { value: 'Keep this draft after a failed refresh' } });
  await act(async () => failRefresh(new Error('Refresh unavailable')));
  expect(screen.getByLabelText('Follow-up note')).toHaveValue('Keep this draft after a failed refresh');
  expect(screen.getByRole('alert')).toHaveTextContent('Refresh unavailable');
  expect(screen.getByRole('button', { name: 'Retry refresh' })).toBeInTheDocument();
});

it.each(['draft', 'pending save'])('pauses compact polling for an uninitialized lead with a snooze %s', async mode => {
  let snooze = emptyLeadSnooze('a');
  let finishSave!: (result: unknown) => void;
  request.mockImplementation(async operation => {
    if (operation === 'context') return { workflow: null, snooze, tasks: [], communications: [], team: [], issues: [] };
    if (operation === 'saveLeadSnooze') return new Promise(resolve => { finishSave = resolve; });
    throw new Error(`Unexpected operation: ${operation}`);
  });
  render(<LeadWorkflowPanel accountId="a" onOpen={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Snooze this lead' }));
  fireEvent.change(screen.getByLabelText('Follow-up note'), { target: { value: 'Keep my follow-up note' } });
  if (mode === 'pending save') fireEvent.click(screen.getByRole('button', { name: 'Snooze lead' }));

  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(request.mock.calls.filter(([operation]) => operation === 'context')).toHaveLength(1);
  expect(screen.getByLabelText('Follow-up note')).toHaveValue('Keep my follow-up note');

  if (mode === 'draft') fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  else {
    snooze = { ...snooze, version: 1, followUpOn: '2026-10-02', note: 'Keep my follow-up note' };
    await act(async () => finishSave({ snooze }));
  }
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(request.mock.calls.filter(([operation]) => operation === 'context')).toHaveLength(2);
  expect(screen.queryByLabelText('Follow-up note')).not.toBeInTheDocument();
});
