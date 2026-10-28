import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Link } from 'react-router-dom';
const h = vi.hoisted(() => ({ load: vi.fn(), request: vi.fn() }));
vi.mock('../lib/relationships', () => ({ searchParties: h.load }));
vi.mock('../lib/communications', () => ({ communicationRequest: h.request }));
vi.mock('../lib/auth', () => ({ useIsAdmin: () => false }));
vi.mock('../lib/client', () => ({ friendlyError: (e: Error) => e.message, client: {}, listAllPages: vi.fn() }));
import Relationships from './Relationships';
const parties = [
  { id: 'apex', kind: 'ORGANIZATION', name: 'Apex Management', email: 'info@example.test', category: 'Property management', revision: 1 },
  { id: 'jane', kind: 'PERSON', name: 'Jane Landlord', email: 'jane@example.test', category: 'Landlord', revision: 1 },
  { id: 'former', kind: 'ORGANIZATION', name: 'Archived Company', archived: true, revision: 1 },
];
beforeEach(() => { h.load.mockImplementation(async (query = '', options: any = {}) => ({ items: parties.filter(p => (options.archived || !p.archived) && (!options.kind || p.kind === options.kind) && [p.name, p.email, p.category].some(v => v?.toLowerCase().includes(query.toLowerCase()))) })); h.request.mockReset(); });
it('finds a standalone person by category and keeps archived profiles out unless requested', async () => {
  render(<MemoryRouter><Relationships /></MemoryRouter>);
  expect(await screen.findByRole('link', { name: 'Apex Management' })).toHaveAttribute('href', '/relationships/apex');
  expect(screen.queryByText('Archived Company')).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Landlord' } });
  expect(await screen.findByRole('link', { name: 'Jane Landlord' })).toBeVisible();
  expect(screen.queryByText('Apex Management')).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
  fireEvent.click(screen.getByLabelText('Include archived'));
  expect(await screen.findByRole('link', { name: 'Archived Company' })).toBeVisible();
});
it('offers an existing shared profile while entering a matching company', async () => {
  render(<MemoryRouter><Relationships /></MemoryRouter>);
  await screen.findByRole('link', { name: 'Apex Management' });
  fireEvent.click(screen.getByRole('button', { name: '+ New relationship' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Apex' } });
  expect(await screen.findByRole('button', { name: 'Use existing profile' })).toBeVisible();
  expect(h.request).not.toHaveBeenCalled();
});
it('keeps an empty search continuation available and loads it only on request', async () => {
  h.load.mockReset().mockResolvedValueOnce({ items: [], nextToken: 'next-page' }).mockResolvedValueOnce({ items: [parties[0]] });
  render(<MemoryRouter><Relationships /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Load more relationships' }));
  expect(await screen.findByRole('link', { name: 'Apex Management' })).toBeVisible();
  expect(h.load).toHaveBeenCalledTimes(2);
  expect(h.load.mock.calls[1][2]).toBe('next-page');
});

it('follows a different search link while the directory remains mounted', async () => {
  render(<MemoryRouter initialEntries={['/relationships?q=Apex']}><Link to="/relationships?q=Landlord">Search landlords</Link><Relationships /></MemoryRouter>);
  await screen.findByRole('link', { name: 'Apex Management' });
  fireEvent.click(screen.getByRole('link', { name: 'Search landlords' }));
  expect(await screen.findByRole('link', { name: 'Jane Landlord' })).toBeVisible();
  expect(screen.getByRole('searchbox')).toHaveValue('Landlord');
  expect(screen.queryByRole('link', { name: 'Apex Management' })).not.toBeInTheDocument();
});
it('checks email matches and keeps name-check continuation available in the create form', async () => {
  h.load.mockImplementation(async (query = '', _options: any, token?: string) => {
    if (query === 'Different name') return token ? { items: [parties[1]] } : { items: [], nextToken: 'name-next' };
    if (query === 'info@example.test') return { items: [parties[0]] };
    return { items: [] };
  });
  render(<MemoryRouter><Relationships /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: '+ New relationship' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Different name' } });
  const next = await screen.findByRole('button', { name: 'Continue checking name matches' });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'info@example.test' } });
  expect(await screen.findByText(/Apex Management/)).toBeVisible();
  fireEvent.click(next);
  expect(await screen.findByText(/Jane Landlord/)).toBeVisible();
  expect(h.load).toHaveBeenCalledWith('Different name', {}, 'name-next');
});
