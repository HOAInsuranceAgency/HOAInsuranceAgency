import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { StrictMode } from 'react';
import { emptyCommercialPlan } from '../../../shared/quotePackages';
import { emptyLeadSnooze } from '../../../shared/leadSnooze';

const h = vi.hoisted(() => ({ resource: null as any }));
vi.mock('../lib/client', () => import('../../scripts/commercial-preview/fixtures'));
vi.mock('../lib/accountsListData', () => ({ useAccountsListData: () => h.resource }));
vi.mock('../components/ReportDownload', () => ({ ReportDownload: () => null }));
import { AdminContext } from '../lib/auth';
import { accountViewKey } from '../lib/accountListView';
import AccountsList from './AccountsList';

beforeEach(() => {
  for (const name of ['localStorage', 'sessionStorage']) {
    const values = new Map<string, string>();
    vi.stubGlobal(name, { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v) });
  }
  const accounts = [
    { id: 'alpha', name: 'Alpha Condominium', stage: 'LEAD', type: 'ASSOCIATION', currentPolicyExpiration: '2099-03-01' },
    { id: 'beta', name: 'Beta Condominium', stage: 'LEAD', type: 'ASSOCIATION', currentPolicyExpiration: '2099-04-01' },
    { id: 'cedar', name: 'Cedar Client', stage: 'CLIENT', type: 'ASSOCIATION' },
  ];
  h.resource = {
    loaded: true, loading: false, error: '', refreshError: '', refetch: vi.fn(), refreshCommercial: vi.fn(), setCommercial: vi.fn(),
    data: { accounts, contacts: [], policies: [], quotes: [], quoteError: '', commercial: {
      team: [{ userId: 'alice', name: 'Alice', salesperson: true, enabled: true, available: true }, { userId: 'bob', name: 'Bob', salesperson: true, enabled: true, available: true }],
      entries: Object.fromEntries(accounts.map(a => [a.id, { salespersonId: a.id === 'beta' ? 'bob' : 'alice', plan: emptyCommercialPlan(a.id), workflowVersion: 1,
        snooze: a.id === 'beta' ? { ...emptyLeadSnooze(a.id), followUpOn: '2099-02-01' } : emptyLeadSnooze(a.id),
      }])),
    } },
  };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function Navigation() {
  const location = useLocation(), navigate = useNavigate();
  return <><output aria-label="View URL">{location.pathname}{location.search}</output>
    <Link to="/leads">Leads link</Link><Link to="/clients">Clients link</Link>
    <button onClick={() => navigate(-1)}>History back</button></>;
}
function page({ scope = 'user-1:ADMIN', admin = true, url = '/leads' } = {}) {
  return <AdminContext.Provider value={admin}><MemoryRouter initialEntries={[url]}><Navigation /><Routes>
    <Route path="/leads" element={<AccountsList stage="LEAD" viewScope={scope} />} />
    <Route path="/clients" element={<AccountsList stage="CLIENT" viewScope={scope} />} />
    <Route path="/accounts/:id" element={<h1>Account opened</h1>} />
  </Routes></MemoryRouter></AdminContext.Provider>;
}
function chooseView(name: string) { fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${name}`) })); }
function names() { return within(screen.getByRole('table')).getAllByRole('row').slice(1).map(row => within(row).getAllByRole('cell')[0].textContent); }

it('keeps filters and sort through account navigation, browser Back and a fresh bare-URL visit', async () => {
  const mounted = render(page());
  chooseView('All leads');
  fireEvent.click(screen.getByRole('button', { name: 'Name' }));
  fireEvent.click(screen.getByRole('button', { name: 'Name' }));
  expect(names()).toEqual(['Beta Condominium', 'Alpha Condominium']);
  fireEvent.change(screen.getByRole('combobox', { name: 'Salesperson' }), { target: { value: 'alice' } });
  expect(screen.getByLabelText('View URL')).toHaveTextContent('/leads?view=all&salesperson=alice&sort=name&dir=desc');
  fireEvent.click(screen.getByText('Alpha Condominium'));
  expect(screen.getByRole('heading', { name: 'Account opened' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'History back' }));
  expect(screen.getByRole('combobox', { name: 'Salesperson' })).toHaveValue('alice');
  expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'descending');
  expect(screen.getByRole('tab', { name: /^All leads/ })).toHaveAttribute('aria-selected', 'true');
  mounted.unmount();
  render(page());
  expect(screen.getByRole('combobox', { name: 'Salesperson' })).toHaveValue('alice');
  expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'descending');
  expect(screen.getByRole('tab', { name: /^All leads/ })).toHaveAttribute('aria-selected', 'true');
});

it('treats an explicit shared URL as the complete view, ahead of this browser preferences', () => {
  window.localStorage.setItem(accountViewKey('user-1:ADMIN', 'LEAD')!, JSON.stringify({ version: 1, leadView: 'All leads', salesperson: 'alice', sortKey: 'name', dir: 'desc' }));
  render(page({ url: '/leads?view=snoozed' }));
  expect(screen.getByRole('tab', { name: /^Snoozed/ })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('combobox', { name: 'Salesperson' })).toHaveValue('');
  expect(screen.getByRole('columnheader', { name: 'Incumbent expires' })).toHaveAttribute('aria-sort', 'ascending');
  expect(names()).toEqual(['Beta Condominium']);
});

it('remembers Lead and Client views independently and can reset a remembered view', () => {
  render(page());
  chooseView('All leads');
  fireEvent.click(screen.getByRole('button', { name: 'Name' }));
  fireEvent.click(screen.getByRole('link', { name: 'Clients link' }));
  expect(screen.getByRole('columnheader', { name: 'Renewal' })).toHaveAttribute('aria-sort', 'ascending');
  fireEvent.click(screen.getByRole('button', { name: 'Units' }));
  fireEvent.click(screen.getByRole('link', { name: 'Leads link' }));
  expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'ascending');
  expect(screen.getByRole('tab', { name: /^All leads/ })).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Reset view' }));
  expect(screen.getByRole('tab', { name: /^Active/ })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('columnheader', { name: 'Incumbent expires' })).toHaveAttribute('aria-sort', 'ascending');
  fireEvent.click(screen.getByRole('link', { name: 'Clients link' }));
  expect(screen.getByRole('columnheader', { name: 'Units' })).toHaveAttribute('aria-sort', 'ascending');
});

it('normalizes invalid and stale filter URLs instead of leaving an empty or hidden selection', async () => {
  render(page({ url: '/leads?view=unknown&salesperson=removed-user&sort=secret-field&dir=wrong&other=keep' }));
  await waitFor(() => expect(screen.getByLabelText('View URL')).toHaveTextContent('/leads?other=keep&view=active&sort=renewal&dir=asc'));
  expect(screen.getByRole('combobox', { name: 'Salesperson' })).toHaveValue('');
  expect(names()).toEqual(['Alpha Condominium']);
});

it('restores a distinct user/role view when switching scope and strips admin-only URL controls', () => {
  const mounted = render(page());
  chooseView('All leads');
  fireEvent.change(screen.getByRole('combobox', { name: 'Salesperson' }), { target: { value: 'alice' } });
  fireEvent.click(screen.getByRole('button', { name: 'Salesperson' }));
  mounted.rerender(page({ scope: 'user-1:PRODUCER', admin: false }));
  expect(screen.getByRole('tab', { name: /^Active/ })).toHaveAttribute('aria-selected', 'true');
  expect(screen.queryByRole('combobox', { name: 'Salesperson' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('View URL')).toHaveTextContent('view=active&sort=renewal&dir=asc');
  chooseView('Snoozed');
  mounted.rerender(page({ scope: 'user-2:PRODUCER', admin: false }));
  expect(screen.getByRole('tab', { name: /^Active/ })).toHaveAttribute('aria-selected', 'true');
  mounted.rerender(page({ scope: 'user-1:ADMIN', admin: true }));
  expect(screen.getByRole('tab', { name: /^All leads/ })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('combobox', { name: 'Salesperson' })).toHaveValue('alice');
  expect(screen.getByRole('columnheader', { name: 'Salesperson' })).toHaveAttribute('aria-sort', 'ascending');
});

it('restores only a matching view position after returning from an account', async () => {
  const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(window, 'scrollY', 'get').mockReturnValue(640);
  render(page());
  fireEvent.scroll(window);
  fireEvent.click(screen.getByText('Alpha Condominium'));
  fireEvent.click(screen.getByRole('button', { name: 'History back' }));
  await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 640, behavior: 'instant' }));
  const position = JSON.parse(window.sessionStorage.getItem(`${accountViewKey('user-1:ADMIN', 'LEAD')}:position`)!);
  expect(Object.keys(position).sort()).toEqual(['signature', 'y']);
  expect(position.signature).not.toContain('Alpha');
});

it('keeps Lead and Client scroll positions separate when the same route component changes stage', async () => {
  let y = 0;
  const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation((options: number | ScrollToOptions) => { if (typeof options === 'object') y = options.top ?? 0; });
  vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => y);
  render(page());
  y = 640; fireEvent.scroll(window);
  fireEvent.click(screen.getByRole('link', { name: 'Clients link' }));
  y = 240; fireEvent.scroll(window);
  fireEvent.click(screen.getByRole('link', { name: 'Leads link' }));
  await waitFor(() => expect(scrollTo).toHaveBeenLastCalledWith({ top: 640, behavior: 'instant' }));
  fireEvent.click(screen.getByRole('link', { name: 'Clients link' }));
  await waitFor(() => expect(scrollTo).toHaveBeenLastCalledWith({ top: 240, behavior: 'instant' }));
});

it('restores a reloaded list position when React rehearses effect cleanup in StrictMode', async () => {
  const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  window.sessionStorage.setItem(`${accountViewKey('user-1:ADMIN', 'LEAD')}:position`, JSON.stringify({
    signature: JSON.stringify({ leadView: 'Active', salesperson: '', sortKey: 'renewal', dir: 'asc' }), y: 480,
  }));
  render(<StrictMode>{page()}</StrictMode>);
  await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 480, behavior: 'instant' }));
});
