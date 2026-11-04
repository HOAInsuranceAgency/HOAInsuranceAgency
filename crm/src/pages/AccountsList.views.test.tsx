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
import { putNamedAccountView, readNamedAccountViews, writeNamedAccountViews } from '../lib/namedAccountViews';
import { normalizeAccountView } from '../lib/accountListView';
import AccountsList from './AccountsList';

beforeEach(() => {
  for (const name of ['localStorage', 'sessionStorage']) {
    const values = new Map<string, string>();
    vi.stubGlobal(name, { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v) });
  }
  const accounts = [
    { id: 'alpha', name: 'Alpha Condominium', state: 'MA', stage: 'LEAD', type: 'ASSOCIATION', currentPolicyExpiration: '2099-03-01' },
    { id: 'beta', name: 'Beta Condominium', state: 'RI', stage: 'LEAD', type: 'ASSOCIATION', currentPolicyExpiration: '2099-04-01' },
    { id: 'cedar', name: 'Cedar Client', state: 'MA', stage: 'CLIENT', type: 'ASSOCIATION' },
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
    signature: JSON.stringify({ leadView: 'Active', salesperson: '', state: '', sortKey: 'renewal', dir: 'asc' }), y: 480,
  }));
  render(<StrictMode>{page()}</StrictMode>);
  await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 480, behavior: 'instant' }));
});

function saveNamed(name: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Save current view' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'View name' }), { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
}

it('filters Massachusetts records through a canonical state URL and restores the filter on reload', () => {
  const first = render(page({ url: '/leads?view=all&state=ma&sort=name&dir=asc' }));
  expect(screen.getByRole('combobox', { name: 'State' })).toHaveValue('MA');
  expect(names()).toEqual(['Alpha Condominium']);
  expect(screen.getByLabelText('View URL')).toHaveTextContent('view=all&state=MA&sort=name&dir=asc');
  first.unmount();
  const reloaded = render(page());
  expect(screen.getByRole('combobox', { name: 'State' })).toHaveValue('MA');
  expect(names()).toEqual(['Alpha Condominium']);
  reloaded.unmount();
  render(page({ url: '/leads?state=ZZ' }));
  expect(screen.getByRole('combobox', { name: 'State' })).toHaveValue('');
  expect(screen.getByLabelText('View URL')).not.toHaveTextContent('state=ZZ');
});

it('saves, selects, updates, renames and deletes a named view after reload', () => {
  const first = render(page());
  chooseView('All leads');
  fireEvent.change(screen.getByRole('combobox', { name: 'State' }), { target: { value: 'MA' } });
  saveNamed('Massachusetts leads');
  expect(screen.getByText('View saved in this browser.')).toBeInTheDocument();
  const id = (screen.getByRole('combobox', { name: 'Saved view' }) as HTMLSelectElement).value;
  expect(id).not.toBe('');
  first.unmount(); render(page());
  expect(screen.getByRole('combobox', { name: 'Saved view' })).toHaveValue(id);
  fireEvent.click(screen.getByRole('button', { name: 'Reset view' }));
  expect(screen.getByRole('combobox', { name: 'State' })).toHaveValue('');
  fireEvent.change(screen.getByRole('combobox', { name: 'Saved view' }), { target: { value: id } });
  expect(screen.getByRole('combobox', { name: 'State' })).toHaveValue('MA');
  expect(names()).toEqual(['Alpha Condominium']);
  fireEvent.change(screen.getByRole('combobox', { name: 'State' }), { target: { value: 'RI' } });
  fireEvent.click(screen.getByRole('button', { name: 'Update saved view' }));
  fireEvent.click(screen.getByRole('button', { name: 'Rename view' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'View name' }), { target: { value: 'Rhode Island leads' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  expect(screen.getByRole('option', { name: 'Rhode Island leads' })).toHaveValue(id);
  expect(readNamedAccountViews(accountViewKey('user-1:ADMIN', 'LEAD'), 'LEAD', true).views[0].view.state).toBe('RI');
  fireEvent.click(screen.getByRole('button', { name: 'Reset view' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Saved view' }), { target: { value: id } });
  expect(names()).toEqual(['Beta Condominium']);
  fireEvent.click(screen.getByRole('button', { name: 'Delete view' }));
  expect(screen.queryByRole('option', { name: 'Rhode Island leads' })).not.toBeInTheDocument();
  expect(readNamedAccountViews(accountViewKey('user-1:ADMIN', 'LEAD'), 'LEAD', true).views).toEqual([]);
});

it('keeps named views isolated by user, exact role and Lead versus Client list', () => {
  const mounted = render(page());
  chooseView('Follow-up due'); saveNamed('My follow-ups');
  fireEvent.click(screen.getByRole('link', { name: 'Clients link' }));
  expect(screen.queryByRole('option', { name: 'My follow-ups' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('link', { name: 'Leads link' }));
  expect(screen.getByRole('option', { name: 'My follow-ups' })).toBeInTheDocument();
  mounted.rerender(page({ scope: 'user-1:PRODUCER', admin: false }));
  expect(screen.queryByRole('option', { name: 'My follow-ups' })).not.toBeInTheDocument();
  mounted.rerender(page({ scope: 'user-2:ADMIN' }));
  expect(screen.queryByRole('option', { name: 'My follow-ups' })).not.toBeInTheDocument();
  mounted.rerender(page({ scope: 'user-1:ADMIN' }));
  expect(screen.getByRole('option', { name: 'My follow-ups' })).toBeInTheDocument();
});

it('shows name validation, prevents duplicate names and renders entered names as text', () => {
  render(page());
  saveNamed('   ');
  expect(screen.getByRole('alert')).toHaveTextContent('Enter a view name.');
  fireEvent.change(screen.getByRole('textbox', { name: 'View name' }), { target: { value: 'x'.repeat(81) } });
  fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
  expect(screen.getByRole('alert')).toHaveTextContent('80 characters or fewer');
  fireEvent.change(screen.getByRole('textbox', { name: 'View name' }), { target: { value: '<Massachusetts leads>' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
  expect(screen.getByRole('option', { name: '<Massachusetts leads>' })).toHaveTextContent('<Massachusetts leads>');
  saveNamed('  <MASSACHUSETTS leads> ');
  expect(screen.getByRole('alert')).toHaveTextContent('already in use');
});

it('honors the twenty-view limit while retaining rename and delete controls', () => {
  const key = accountViewKey('user-1:ADMIN', 'LEAD');
  let views = readNamedAccountViews(key, 'LEAD', true).views;
  for (let i = 0; i < 20; i++) views = putNamedAccountView(views, { name: `View ${i + 1}`, view: normalizeAccountView({}, 'LEAD', true) }, 'LEAD', true);
  writeNamedAccountViews(key, views, 'LEAD', true);
  render(page());
  expect(screen.getByRole('button', { name: 'Save current view' })).toBeDisabled();
  expect(screen.getByText(/You have 20 saved views/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Delete view' }));
  expect(screen.getByRole('button', { name: 'Save current view' })).toBeEnabled();
});

it('reports failed browser storage without claiming a view was saved or deleted', () => {
  render(page());
  saveNamed('Original view');
  vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded'); });
  fireEvent.click(screen.getByRole('button', { name: 'Delete view' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Could not save views in this browser');
  expect(screen.getByRole('option', { name: 'Original view' })).toBeInTheDocument();
  saveNamed('Another view');
  expect(screen.getByRole('alert')).toHaveTextContent('Could not save views in this browser');
  expect(screen.queryByRole('option', { name: 'Another view' })).not.toBeInTheDocument();
});

it('preserves fresh preferences when renaming and a fresh name when updating from another open tab', () => {
  render(page()); saveNamed('Shared view');
  const key = accountViewKey('user-1:ADMIN', 'LEAD');
  let latest = readNamedAccountViews(key, 'LEAD', true).views;
  const id = latest[0].id;
  latest = putNamedAccountView(latest, { id, name: 'Shared view', view: { ...latest[0].view, state: 'MA' } }, 'LEAD', true);
  writeNamedAccountViews(key, latest, 'LEAD', true);
  fireEvent.click(screen.getByRole('button', { name: 'Rename view' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'View name' }), { target: { value: 'Renamed here' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  expect(readNamedAccountViews(key, 'LEAD', true).views[0].view.state).toBe('MA');
  latest = readNamedAccountViews(key, 'LEAD', true).views;
  writeNamedAccountViews(key, putNamedAccountView(latest, { id, name: 'Fresh name', view: latest[0].view }, 'LEAD', true), 'LEAD', true);
  fireEvent.click(screen.getByRole('button', { name: 'Update saved view' }));
  expect(readNamedAccountViews(key, 'LEAD', true).views[0]).toMatchObject({ id, name: 'Fresh name', view: { state: '' } });
});
