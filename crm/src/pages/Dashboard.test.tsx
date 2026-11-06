import { fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter, useLocation } from 'react-router-dom';
import { expect, it, vi } from 'vitest';

vi.mock('./dashboard/PerformanceTab', () => ({ default: () => <p>Performance snapshot</p> }));
vi.mock('./dashboard/LeadsTab', () => ({ default: () => <p>Leads snapshot</p> }));
vi.mock('./dashboard/FinanceTab', () => ({ default: () => <p>Finance snapshot</p> }));
import Dashboard from './Dashboard';

function Location() {
  const location = useLocation();
  return <><output aria-label="Current URL">{location.pathname}{location.search}</output><Link to="/">Dashboard link</Link></>;
}

it('uses the same tab navigation for every viewport while keeping URLs authoritative', () => {
  render(<MemoryRouter initialEntries={['/?tab=finance&keep=1']}><Dashboard /><Location /></MemoryRouter>);
  expect(screen.queryByRole('combobox', { name: 'Dashboard view' })).not.toBeInTheDocument();
  expect(screen.getByRole('tablist', { name: 'Dashboard views' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Finance' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tabpanel', { name: 'Finance' })).toHaveTextContent('Finance snapshot');
  fireEvent.click(screen.getByRole('tab', { name: 'Leads' }));
  expect(screen.getByLabelText('Current URL')).toHaveTextContent('/?tab=leads&keep=1');
  expect(screen.queryByText('Finance snapshot')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('link', { name: 'Dashboard link' }));
  expect(screen.getByRole('tab', { name: 'Dashboard' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tabpanel', { name: 'Dashboard' })).toHaveTextContent('Performance snapshot');
});
