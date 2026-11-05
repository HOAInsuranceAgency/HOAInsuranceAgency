import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ request: vi.fn(), search: vi.fn(), create: vi.fn(), update: vi.fn() }));
vi.mock('../lib/communications', () => ({ communicationRequest: h.request }));
vi.mock('../lib/relationships', () => ({ searchParties: h.search }));
vi.mock('../lib/auth', () => ({ useIsAdmin: () => false }));
vi.mock('../lib/client', async original => ({ ...await original<typeof import('../lib/client')>(),
  client: { models: { License: { create: h.create, update: h.update } } } }));
import PartyForm from './PartyForm';
import LicenseForm from './licensing/LicenseForm';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  h.search.mockResolvedValue({ items: [] });
});

it('retains the exact relationship request identity after an uncertain failure and changed fields after editing', async () => {
  h.request.mockRejectedValueOnce(new Error('Response could not be confirmed')).mockResolvedValue({ party: { id: 'saved' } });
  const onSaved = vi.fn();
  render(<PartyForm onSaved={onSaved} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Fictional management' } });
  const form = screen.getByRole('button', { name: 'Save relationship' }).closest('form')!;
  fireEvent.submit(form);
  await screen.findByText('Response could not be confirmed');
  expect(onSaved).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Name')).toHaveValue('Fictional management');
  const requestId = h.request.mock.calls[0][1].requestId;
  fireEvent.submit(form);
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(h.request.mock.calls[1][1].requestId).toBe(requestId);
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Changed fictional management' } });
  fireEvent.submit(form);
  await waitFor(() => expect(h.request).toHaveBeenCalledTimes(3));
  expect(h.request.mock.calls[2][1]).toMatchObject({ name: 'Changed fictional management' });
  expect(h.request.mock.calls[2][1].requestId).not.toBe(requestId);
});

it('executes one relationship write for repeated submits and ignores its callback after unmount', async () => {
  const pending = deferred<{ party: { id: string } }>();
  h.request.mockReturnValue(pending.promise);
  const onSaved = vi.fn();
  const { unmount } = render(<PartyForm onSaved={onSaved} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Fictional management' } });
  const form = screen.getByRole('button', { name: 'Save relationship' }).closest('form')!;
  act(() => { fireEvent.submit(form); fireEvent.submit(form); });
  expect(h.request).toHaveBeenCalledTimes(1);
  unmount();
  await act(async () => { pending.resolve({ party: { id: 'saved' } }); });
  expect(onSaved).not.toHaveBeenCalled();
});

it('executes one license write and balances parent busy feedback when a late response follows unmount', async () => {
  const pending = deferred<{ data: { id: string }; errors: undefined }>();
  h.create.mockReturnValue(pending.promise);
  const onSaved = vi.fn(), onSaving = vi.fn();
  const { unmount } = render(<LicenseForm holderType="FIRM" existing={null} profiles={[]} onSaved={onSaved} onSaving={onSaving} onCancel={vi.fn()} />);
  const state = screen.getByText('State *').parentElement!.querySelector('select')!;
  const number = screen.getByText('License number *').parentElement!.querySelector('input')!;
  fireEvent.change(state, { target: { value: 'MA' } });
  fireEvent.change(number, { target: { value: 'fictional-license' } });
  const save = screen.getByRole('button', { name: 'Add license' });
  act(() => { fireEvent.click(save); fireEvent.click(save); });
  expect(h.create).toHaveBeenCalledTimes(1);
  expect(onSaving).toHaveBeenCalledExactlyOnceWith(true);
  unmount();
  await act(async () => { pending.resolve({ data: { id: 'saved-license' }, errors: undefined }); });
  expect(onSaved).not.toHaveBeenCalled();
  expect(onSaving.mock.calls).toEqual([[true], [false]]);
});
