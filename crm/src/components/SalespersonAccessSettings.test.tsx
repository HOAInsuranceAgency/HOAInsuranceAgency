import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_SALESPERSON_ACCESS } from '../../../shared/salespersonAccess';
const h = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../lib/communications', () => ({ communicationRequest: h.request }));
vi.mock('../lib/client', () => ({ friendlyError: (error: unknown) => error instanceof Error ? error.message : 'Failed' }));
import SalespersonAccessSettings from './SalespersonAccessSettings';
beforeEach(() => {
  h.request.mockReset();
  h.request.mockImplementation(async (operation: string, input: { policy: unknown }) => operation === 'salespersonAccessSettings'
    ? { policy: DEFAULT_SALESPERSON_ACCESS, version: 0 }
    : { policy: input.policy, version: 1, updatedAt: '2026-11-18T12:00:00Z', updatedBy: 'admin' });
});
it('starts restrictive and saves the three independent sections explicitly', async () => {
  render(<SalespersonAccessSettings />);
  const visibility = await screen.findByLabelText('Which accounts can salespeople see?');
  expect(visibility).toHaveValue('ASSIGNED');
  expect(screen.getByLabelText('Access to other salespeople’s accounts')).toHaveValue('READ');
  expect(screen.getByLabelText('Allow sending emails and proposals')).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Save access settings' })).toBeDisabled();
  fireEvent.change(visibility, { target: { value: 'ALL' } });
  fireEvent.change(screen.getByLabelText('Access to other salespeople’s accounts'), { target: { value: 'EDIT' } });
  fireEvent.click(screen.getByLabelText('Allow binding policies'));
  expect(h.request).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Save access settings' }));
  await waitFor(() => expect(h.request).toHaveBeenCalledWith('saveSalespersonAccessSettings', {
    version: 0, policy: { visibility: 'ALL', level: 'EDIT', send: false, invoice: false, bind: true },
  }, true));
  await screen.findByText('Salesperson access saved.');
});
it('retains a failed draft and offers a reload instead of silently overwriting a newer policy', async () => {
  render(<SalespersonAccessSettings />);
  fireEvent.change(await screen.findByLabelText('Which accounts can salespeople see?'), { target: { value: 'LEADS' } });
  h.request.mockRejectedValueOnce(new Error('Access settings changed. Reload them before saving.'));
  fireEvent.click(screen.getByRole('button', { name: 'Save access settings' }));
  await screen.findByText('Access settings changed. Reload them before saving.');
  expect(screen.getByLabelText('Which accounts can salespeople see?')).toHaveValue('LEADS');
});
