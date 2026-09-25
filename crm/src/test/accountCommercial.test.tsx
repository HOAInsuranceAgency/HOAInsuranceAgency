import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
vi.mock(
  '../lib/client',
  () => import('../../scripts/commercial-preview/fixtures'),
);
vi.mock(
  '../lib/communications',
  () => import('../../scripts/commercial-preview/fixtures'),
);
import AccountsList from '../pages/AccountsList';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-09-14T13:00:00Z');
});
afterEach(() => vi.useRealTimers());

it('keeps unfinished packages in Leads and does not carry a hidden owner filter into Clients', async () => {
  const page = render(
    <MemoryRouter>
      <AccountsList stage="LEAD" />
    </MemoryRouter>,
  );
  expect(await screen.findByText('Binding in progress')).toBeTruthy();
  expect(await screen.findByText('$250')).toBeTruthy();
  expect(screen.getByText('Quote form')).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', { name: 'Salesperson' }), {
    target: { value: 'champ' },
  });
  expect(screen.getByText('No leads found.')).toBeTruthy();
  page.rerender(
    <MemoryRouter>
      <AccountsList stage="CLIENT" />
    </MemoryRouter>,
  );
  expect(await screen.findByText('Cedar House — partially bound')).toBeTruthy();
  expect(screen.getByRole('columnheader', { name: 'City' })).toBeTruthy();
  expect(screen.getByRole('columnheader', { name: 'State' })).toBeTruthy();
  expect(screen.queryByRole('combobox', { name: 'Salesperson' })).toBeNull();
});
