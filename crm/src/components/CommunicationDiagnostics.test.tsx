import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
const request = vi.hoisted(() => vi.fn());
vi.mock('../lib/communications', () => ({ communicationRequest: request }));
import CommunicationDiagnostics from './CommunicationDiagnostics';

it('preserves a review draft through refresh and a transient queue failure', async () => {
  request.mockResolvedValue({ items: [{ id: 'issue', version: 1, message: 'Investigate this' }] });
  render(<MemoryRouter><CommunicationDiagnostics /></MemoryRouter>);
  const field = await screen.findByRole('textbox', { name: 'Resolution or reason this is unrelated', hidden: true });
  fireEvent.change(field, { target: { value: 'Review in progress' } });
  let reject!: (reason: Error) => void;
  request.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh queue' }));
  expect(screen.getByRole('textbox', { name: 'Resolution or reason this is unrelated', hidden: true })).toBe(field);
  await act(async () => reject(new Error('Connection lost')));
  expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost');
  expect(field).toHaveValue('Review in progress');
  request.mockResolvedValue({ items: [{ id: 'issue', version: 2, message: 'Updated issue' }] });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh queue' }));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(field).toHaveValue('Review in progress');
});
