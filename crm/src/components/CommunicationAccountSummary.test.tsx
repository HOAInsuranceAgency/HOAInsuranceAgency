import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../lib/communications', () => ({ communicationRequest: api.read }));
vi.mock('../lib/client', () => ({
  fmtDate: (value: string) => value,
  fmtProviderPhone: (value: string) => value,
  friendlyError: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback,
}));
vi.mock('./ContactActions', () => ({ default: () => null }));
import CommunicationAccountSummary from './CommunicationAccountSummary';

beforeEach(() => vi.resetAllMocks());
it('keeps the Front open callback and trusted absolute CRM prefix/query/fragment for account tab links', async () => {
  const url = 'https://crm.example.test/prefix/accounts/a%2Fb?submission=s%2F1#contacts';
  api.read.mockResolvedValue({ summary: { name: 'Fictional HOA', url, more: false, contacts: [], quotes: [], documents: [] } });
  const open = vi.fn();
  render(<CommunicationAccountSummary accountId="a/b" open={open} />);
  fireEvent.click(await screen.findByRole('button', { name: /Open CRM account/ }));
  expect(open).toHaveBeenLastCalledWith(url);
  fireEvent.click(screen.getByText(/Account details/));
  fireEvent.click(screen.getByRole('button', { name: 'View quotes & bind' }));
  expect(open).toHaveBeenLastCalledWith('https://crm.example.test/prefix/accounts/a%2Fb?submission=s%2F1&tab=quotes#contacts');
  fireEvent.click(screen.getByRole('button', { name: 'View all documents' }));
  expect(open).toHaveBeenLastCalledWith('https://crm.example.test/prefix/accounts/a%2Fb?submission=s%2F1&tab=documents#contacts');
  expect(api.read).toHaveBeenCalledExactlyOnceWith('accountSummary', { accountId: 'a/b' });
});
