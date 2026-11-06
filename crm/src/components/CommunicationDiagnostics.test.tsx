import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
const request = vi.hoisted(() => vi.fn());
vi.mock('../lib/communications', () => ({ communicationRequest: request }));
import CommunicationDiagnostics from './CommunicationDiagnostics';
import { invalidateLiveUpdates } from '../test/liveUpdates';

it('defers automatic queue updates while reviewing, preserves rows on failure and recovers automatically', async () => {
  request.mockResolvedValue({ items: [{ id: 'issue', version: 1, message: 'Investigate this' }] });
  render(<MemoryRouter><CommunicationDiagnostics /></MemoryRouter>);
  const field = await screen.findByRole('textbox', { name: 'Resolution or reason this is unrelated', hidden: true });
  fireEvent.change(field, { target: { value: 'Review in progress' } });
  request.mockRejectedValueOnce(new Error('Connection lost'));
  await invalidateLiveUpdates();
  expect(request).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('textbox', { name: 'Resolution or reason this is unrelated', hidden: true })).toBe(field);
  expect(field).toHaveValue('Review in progress');
  fireEvent.change(field, { target: { value: '' } });
  expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost');
  expect(screen.getByText('Investigate this')).toBeInTheDocument();
  request.mockResolvedValue({ items: [{ id: 'issue', version: 2, message: 'Updated issue' }] });
  await invalidateLiveUpdates();
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(screen.getByText('Updated issue')).toBeInTheDocument();
  expect(field).toHaveValue('');
});
