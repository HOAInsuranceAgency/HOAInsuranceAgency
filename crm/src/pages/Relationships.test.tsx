import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
const h = vi.hoisted(() => ({ load: vi.fn(), request: vi.fn() }));
vi.mock('../lib/relationships', () => ({ loadParties: h.load }));
vi.mock('../lib/communications', () => ({ communicationRequest: h.request }));
vi.mock('../lib/auth', () => ({ useIsAdmin: () => false }));
vi.mock('../lib/client', () => ({ friendlyError: (e: Error) => e.message, client: {}, listAllPages: vi.fn() }));
import Relationships from './Relationships';
const parties = [
  { id: 'apex', kind: 'ORGANIZATION', name: 'Apex Management', email: 'info@example.test', category: 'Property management', revision: 1 },
  { id: 'jane', kind: 'PERSON', name: 'Jane Landlord', email: 'jane@example.test', category: 'Landlord', revision: 1 },
  { id: 'former', kind: 'ORGANIZATION', name: 'Archived Company', archived: true, revision: 1 },
];
beforeEach(() => { h.load.mockResolvedValue(parties); h.request.mockReset(); });
it('finds a standalone person by category and keeps archived profiles out unless requested', async () => {
  render(<MemoryRouter><Relationships /></MemoryRouter>);
  expect(await screen.findByRole('link', { name: 'Apex Management' })).toHaveAttribute('href', '/relationships/apex');
  expect(screen.queryByText('Archived Company')).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Landlord' } });
  expect(screen.getByRole('link', { name: 'Jane Landlord' })).toBeVisible();
  expect(screen.queryByText('Apex Management')).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
  fireEvent.click(screen.getByLabelText('Include archived'));
  expect(screen.getByRole('link', { name: 'Archived Company' })).toBeVisible();
});
it('offers an existing shared profile while entering a matching company', async () => {
  render(<MemoryRouter><Relationships /></MemoryRouter>);
  await screen.findByRole('link', { name: 'Apex Management' });
  fireEvent.click(screen.getByRole('button', { name: '+ New relationship' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Apex' } });
  expect(await screen.findByRole('button', { name: 'Use existing profile' })).toBeVisible();
  expect(h.request).not.toHaveBeenCalled();
});
