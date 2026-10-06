import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const model = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() }));
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ models: { AppetiteGuide: model } }) }));
import { AppetiteGuides } from './AppetiteGuides';

beforeEach(() => {
  vi.resetAllMocks();
  model.list.mockResolvedValue({ data: [{ id: 'g1', carrierId: 'c1', notes: 'Existing guide' }] });
});

it('waits for a complete initial read before allowing creation and offers retry after failure', async () => {
  let resolve!: (value: unknown) => void;
  model.list.mockReturnValue(new Promise(done => { resolve = done; }));
  render(<AppetiteGuides carrierId="c1" />);
  expect(screen.getByRole('button', { name: '+ Add appetite guide' })).toBeDisabled();
  await act(async () => resolve({ data: [], errors: [{ message: 'List unavailable' }] }));
  expect(screen.getByRole('button', { name: '+ Add appetite guide' })).toBeDisabled();
  model.list.mockResolvedValue({ data: [] });
  fireEvent.click(screen.getByRole('button', { name: 'Retry appetite guides' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '+ Add appetite guide' })).toBeEnabled());
});

it('keeps a guide and shows an error when deletion is refused', async () => {
  model.delete.mockResolvedValue({ data: null, errors: [{ message: 'Delete failed' }] });
  render(<AppetiteGuides carrierId="c1" />);
  await screen.findByText('Existing guide');
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Delete failed');
  expect(screen.getByText('Existing guide')).toBeInTheDocument();
});

it('recovers a rejected save without losing its draft or permitting a second editor during the request', async () => {
  let reject!: (error: Error) => void;
  model.create.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
  render(<AppetiteGuides carrierId="c1" />);
  await screen.findByText('Existing guide');
  fireEvent.click(screen.getByRole('button', { name: '+ Add appetite guide' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New guide draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add guide' }));
  expect(screen.getByRole('textbox')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
  expect(screen.getAllByRole('button', { name: 'Cancel' }).every(button => button.hasAttribute('disabled'))).toBe(true);
  await act(async () => reject(new Error('Connection lost')));
  expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost');
  expect(screen.getByRole('textbox')).toHaveValue('New guide draft');
  expect(screen.getByRole('button', { name: 'Add guide' })).toBeEnabled();
  model.create.mockResolvedValue({ data: { id: 'g2', carrierId: 'c1', notes: 'New guide draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add guide' }));
  await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
  expect(screen.getByText('New guide draft')).toBeInTheDocument();
});
