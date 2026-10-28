import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../lib/communications', () => ({ communicationRequest: h.request }));
import ManagementChangeForm from './ManagementChangeForm';
const parties = [{ id: 'new', kind: 'ORGANIZATION' as const, name: 'New Management', email: 'new@example.com', ownerId: 'alice', revision: 1 }, { id: 'person', kind: 'PERSON' as const, name: 'Pat Manager', email: 'pat@example.com', ownerId: 'alice', revision: 1 }];
function show() {
  const saved = vi.fn();
  render(<MemoryRouter><ManagementChangeForm accountId="a" version={3} parties={parties} contacts={[{ id: 'old-contact', accountId: 'a', name: 'Former representative', email: 'old@example.com' } as never, { id: 'board', accountId: 'a', name: 'Board president' } as never]} relationships={[]} onClose={vi.fn()} onSaved={saved} /></MemoryRouter>);
  return saved;
}
beforeEach(() => h.request.mockReset().mockResolvedValue({ version: 4 }));
it('requires a reviewed handoff and retires only selected contacts', async () => {
  const saved = show();
  expect(screen.getByRole('button', { name: 'Save management change' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('New manager'), { target: { value: 'new' } });
  fireEvent.change(screen.getByLabelText('Effective date'), { target: { value: '2026-11-01' } });
  fireEvent.change(screen.getByLabelText('General correspondence and forms'), { target: { value: 'person' } });
  fireEvent.click(screen.getByLabelText(/Former representative/));
  fireEvent.click(screen.getByLabelText('I reviewed the effective date and contact handoff.'));
  fireEvent.click(screen.getByRole('button', { name: 'Save management change' }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(h.request).toHaveBeenCalledWith('relationshipChangeManagement', expect.objectContaining({ accountId: 'a', version: 3, partyId: 'new', effectiveOn: '2026-11-01', generalPartyId: 'person', retireContactIds: ['old-contact'] }), true);
});
it('retains all entered data on failure and retries the same request id', async () => {
  h.request.mockRejectedValueOnce(new Error('Storage unavailable'));
  show();
  fireEvent.change(screen.getByLabelText('New manager'), { target: { value: 'new' } });
  fireEvent.change(screen.getByLabelText('Handoff note'), { target: { value: 'Board confirmed the change' } });
  fireEvent.click(screen.getByLabelText('I reviewed the effective date and contact handoff.'));
  fireEvent.click(screen.getByRole('button', { name: 'Save management change' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Storage unavailable');
  expect(screen.getByLabelText('Handoff note')).toHaveValue('Board confirmed the change');
  fireEvent.click(screen.getByRole('button', { name: 'Save management change' }));
  await waitFor(() => expect(h.request).toHaveBeenCalledTimes(2));
  expect(h.request.mock.calls[1][1].requestId).toBe(h.request.mock.calls[0][1].requestId);
});
it('requires another review after changing the effective date', () => {
  show();
  fireEvent.click(screen.getByLabelText('I reviewed the effective date and contact handoff.'));
  fireEvent.change(screen.getByLabelText('Effective date'), { target: { value: '2026-11-01' } });
  expect(screen.getByRole('button', { name: 'Save management change' })).toBeDisabled();
});
