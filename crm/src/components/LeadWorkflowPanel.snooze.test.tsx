import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { emptyLeadSnooze } from '../../../shared/leadSnooze';

const request = vi.hoisted(() => vi.fn());
vi.mock('../lib/communications', () => ({ communicationRequest: request }));
vi.mock('../lib/client', () => import('../../scripts/commercial-preview/fixtures'));
vi.mock('./CommunicationAccountSummary', () => ({ default: () => null }));
import LeadWorkflowPanel from './LeadWorkflowPanel';

const accessDenied = 'This record is not available to your account. Contact an administrator if it needs to be assigned to you.';
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function context(name = 'Example lead', subject = 'Private renewal discussion') {
  return {
    workflow: { accountId: 'a', name, version: 1, disposition: 'ACTIVE', humanTakeover: true, salespersonId: 'owner' },
    snooze: emptyLeadSnooze('a'), tasks: [],
    communications: [{ id: 'private-message', channel: 'EMAIL', direction: 'INBOUND', status: 'RECEIVED', provider: 'front', providerId: 'private-source', at: '2026-10-01T15:00:00Z', subject, text: `${subject} body` }],
    team: [{ userId: 'owner', name: 'Original salesperson', enabled: true, salesperson: true }], issues: [],
  };
}
function expectPrivateContextCleared() {
  expect(screen.queryByText('Private renewal discussion')).not.toBeInTheDocument();
  expect(screen.queryByText('Private renewal discussion body')).not.toBeInTheDocument();
  expect(screen.queryByText('Original salesperson')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Edit salesperson' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Snooze Example lead' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Follow-up note')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Internal note')).not.toBeInTheDocument();
}

beforeEach(() => {
  request.mockReset();
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime('2026-10-01T16:00:00Z');
});
afterEach(() => vi.useRealTimers());

it('keeps a follow-up draft mounted while another account action refreshes the workspace', async () => {
  const refresh = deferred<unknown>();
  let reads = 0;
  request.mockImplementation(operation => operation === 'context' ? ++reads === 1 ? Promise.resolve(context()) : refresh.promise : Promise.resolve({}));
  render(<LeadWorkflowPanel accountId="a" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Snooze Example lead' }));
  fireEvent.change(screen.getByLabelText('Follow-up note'), { target: { value: 'Draft follow-up' } });
  fireEvent.change(screen.getByLabelText('Internal note'), { target: { value: 'Save this note' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
  await act(async () => {});
  expect(screen.getByLabelText('Follow-up note')).toHaveValue('Draft follow-up');
  expect(screen.getByLabelText('Internal note')).toBeDisabled();
  await act(async () => refresh.resolve(context()));
  expect(screen.getByLabelText('Follow-up note')).toHaveValue('Draft follow-up');
  expect(screen.getByLabelText('Internal note')).toHaveValue('');
});

it('does not append an older page after the communication history has refreshed', async () => {
  const page = deferred<unknown>();
  let reads = 0;
  request.mockImplementation((operation, input) => {
    if (operation !== 'context') throw new Error(`Unexpected operation: ${operation}`);
    if (input.nextToken) return page.promise;
    return Promise.resolve({ ...context('Example lead', ++reads === 1 ? 'Original history' : 'Refreshed history'), communicationNextToken: reads === 1 ? 'old-page' : undefined });
  });
  render(<LeadWorkflowPanel accountId="a" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Load older activity' }));
  expect(screen.getByRole('button', { name: 'Loading older activity…' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText('Refreshed history');
  await act(async () => page.resolve(context('Example lead', 'Stale older history')));
  expect(screen.queryByText('Stale older history')).not.toBeInTheDocument();
  expect(screen.getByText('Refreshed history')).toBeInTheDocument();
});

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

it.each(['compact', 'full'] as const)('erases revoked context and drafts through failed retries, then shows fresh authorized data (%s)', async mode => {
  const refresh = deferred<unknown>();
  const retry = deferred<unknown>();
  const reauthorized = deferred<unknown>();
  request.mockResolvedValueOnce(context())
    .mockImplementationOnce(() => refresh.promise)
    .mockImplementationOnce(() => retry.promise)
    .mockImplementationOnce(() => reauthorized.promise);
  render(<LeadWorkflowPanel accountId="a" {...(mode === 'compact' ? { onOpen: vi.fn() } : {})} />);
  await screen.findByRole('button', { name: 'Snooze Example lead' });
  expect(screen.getByText('Private renewal discussion')).toBeInTheDocument();
  if (mode === 'compact') await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  else fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  fireEvent.click(screen.getByRole('button', { name: 'Snooze Example lead' }));
  fireEvent.change(screen.getByLabelText('Follow-up note'), { target: { value: 'Discard this revoked follow-up draft' } });
  if (mode === 'compact') fireEvent.click(screen.getByText('Add a note'));
  fireEvent.change(screen.getByLabelText('Internal note'), { target: { value: 'Discard this revoked internal draft' } });

  await act(async () => refresh.reject(new Error(accessDenied)));
  expect(screen.getByRole('alert')).toHaveTextContent(accessDenied);
  expectPrivateContextCleared();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(screen.getByRole('status')).toHaveTextContent('Loading account communications');
  expectPrivateContextCleared();
  await act(async () => retry.reject(new Error('Temporary network failure')));
  expect(screen.getByRole('alert')).toHaveTextContent('Temporary network failure');
  expectPrivateContextCleared();

  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  const fresh = context('Freshly assigned lead', 'Fresh authorized conversation');
  fresh.team[0].name = 'New salesperson';
  fresh.workflow.version = 2;
  await act(async () => reauthorized.resolve(fresh));
  expect(screen.getByText('Fresh authorized conversation')).toBeInTheDocument();
  expect(screen.getByText('New salesperson')).toBeInTheDocument();
  expect(screen.queryByText('Private renewal discussion')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Internal note')).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: 'Snooze Freshly assigned lead' }));
  expect(screen.getByLabelText('Follow-up note')).toHaveValue('');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it.each([
  ['raw Unauthorized message', new Error('Unauthorized')],
  ['authorization error name', Object.assign(new Error('Request failed'), { name: 'UnauthorizedException' })],
  ['GraphQL authorization error type', { errorType: 'Unauthorized', message: 'Request failed' }],
  ['wrapped GraphQL authorization error', { errors: [{ errorType: 'Unauthorized', message: 'Request failed' }] }],
] as const)('clears previously authorized data for a %s', async (_label, denied) => {
  const refresh = deferred<unknown>();
  request.mockResolvedValueOnce(context()).mockImplementationOnce(() => refresh.promise);
  render(<LeadWorkflowPanel accountId="a" />);
  await screen.findByRole('button', { name: 'Snooze Example lead' });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await act(async () => refresh.reject(denied));
  expectPrivateContextCleared();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
});

it('clears access denied from older activity and ignores an in-flight context refresh', async () => {
  const refresh = deferred<unknown>();
  const older = deferred<unknown>();
  request.mockImplementation((operation, input) => {
    if (operation !== 'context') throw new Error(`Unexpected operation: ${operation}`);
    if (input.nextToken) return older.promise;
    const contextReads = request.mock.calls.filter(([op, args]) => op === 'context' && !args.nextToken).length;
    return contextReads === 1 ? Promise.resolve({ ...context(), communicationNextToken: 'older-page' }) : refresh.promise;
  });
  render(<LeadWorkflowPanel accountId="a" />);
  await screen.findByRole('button', { name: 'Snooze Example lead' });
  fireEvent.click(screen.getByRole('button', { name: 'Load older activity' }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await act(async () => older.reject(new Error(accessDenied)));
  expectPrivateContextCleared();
  expect(screen.getByRole('alert')).toHaveTextContent(accessDenied);
  await act(async () => refresh.resolve(context()));
  expectPrivateContextCleared();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
});

it('does not restore revoked context when an earlier snooze save finishes', async () => {
  const refresh = deferred<unknown>();
  const save = deferred<unknown>();
  request.mockImplementation((operation) => {
    if (operation === 'saveLeadSnooze') return save.promise;
    if (operation !== 'context') throw new Error(`Unexpected operation: ${operation}`);
    return request.mock.calls.filter(([op]) => op === 'context').length === 1 ? Promise.resolve(context()) : refresh.promise;
  });
  render(<LeadWorkflowPanel accountId="a" />);
  await screen.findByRole('button', { name: 'Snooze Example lead' });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  fireEvent.click(screen.getByRole('button', { name: 'Snooze Example lead' }));
  fireEvent.change(screen.getByLabelText('Follow-up note'), { target: { value: 'Private pending save' } });
  fireEvent.click(screen.getByRole('button', { name: 'Snooze lead' }));
  await act(async () => refresh.reject(new Error(accessDenied)));
  expectPrivateContextCleared();
  await act(async () => save.resolve({ snooze: { accountId: 'a', version: 1, followUpOn: '2026-10-02', note: 'Private pending save' } }));
  expectPrivateContextCleared();
  expect(screen.getByRole('alert')).toHaveTextContent(accessDenied);
});
