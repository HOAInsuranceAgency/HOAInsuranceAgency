import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, Link, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Field } from './kit';
import { StatusEditor } from './StatusEditor';
import { DirtyFormsProvider } from './unsaved';
import { useFormState } from '../../lib/useFormState';
import { MoneyInput } from '../inputs';
import { SortTh, useSort } from '../../lib/useSort';

afterEach(() => vi.restoreAllMocks());
describe('CRM interaction kit', () => {
  it('names native and formatted inputs and groups checkbox fields without a dangling label', () => {
    render(<><Field><label>Premium</label><MoneyInput value="1500000" onChange={() => {}} /></Field><Field><label>Carrier</label><input /></Field><Field><label>Coverages</label><div><label><input type="checkbox" />Property</label></div></Field></>);
    expect(screen.getByLabelText('Premium')).toHaveValue('1,500,000');
    expect(screen.getByLabelText('Carrier')).toHaveAttribute('id');
    expect(screen.getByRole('group', { name: 'Coverages' })).toContainElement(screen.getByRole('checkbox', { name: 'Property' }));
  });
  it('sorts by keyboard with the direction on the column header', async () => {
    const toggle = vi.fn(); const user = userEvent.setup();
    render(<table><thead><tr><SortTh label="Renewal" colKey="renewal" sortKey="renewal" dir="asc" onToggle={toggle} /></tr></thead></table>);
    await user.tab(); await user.keyboard('{Enter}');
    expect(toggle).toHaveBeenCalledWith('renewal');
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'ascending');
  });
  it('does not mutate a selected status until saved, preserves failed drafts, and cancels without writing', async () => {
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<StatusEditor value="ACTIVE" options={['ACTIVE', 'CANCELLED']} label="Policy 123" onSave={save} />);
    fireEvent.click(screen.getByRole('button', { name: /Change status/ }));
    fireEvent.change(screen.getByLabelText('Policy 123 status'), { target: { value: 'CANCELLED' } });
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save status' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save status' })).toBeEnabled());
    expect(screen.getByLabelText('Policy 123 status')).toHaveValue('CANCELLED');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(save).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Change status/ }));
    expect(screen.getByLabelText('Policy 123 status')).toHaveValue('ACTIVE');
  });
});
function Editor() {
  const form = useFormState({ name: '' });
  return <><label>Name<input value={form.form.name} onChange={e => form.setF('name', e.target.value)} /></label><button onClick={() => form.markSaved()}>Save</button><Link to="/elsewhere">Leave</Link></>;
}
function mountEditor() {
  const router = createMemoryRouter([{path: '*', element: <DirtyFormsProvider><Editor /></DirtyFormsProvider>}]);
  render(<RouterProvider router={router} />); return router;
}
it('blocks leaving a draft, allows staying, and clears the blocker after a successful save', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false); const router = mountEditor();
  fireEvent.change(screen.getByLabelText('Name'), {target: {value: 'New name'}});
  fireEvent.click(screen.getByRole('link', {name: 'Leave'}));
  await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  expect(router.state.location.pathname).toBe('/');
  fireEvent.click(screen.getByRole('button', {name: 'Save'}));
  fireEvent.click(screen.getByRole('link', {name: 'Leave'}));
  await waitFor(() => expect(router.state.location.pathname).toBe('/elsewhere'));
  expect(confirm).toHaveBeenCalledOnce();
});
it('allows an explicitly confirmed discard', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true); const router = mountEditor();
  fireEvent.change(screen.getByLabelText('Name'), {target: {value: 'Draft'}});
  fireEvent.click(screen.getByRole('link', {name: 'Leave'}));
  await waitFor(() => expect(router.state.location.pathname).toBe('/elsewhere'));
});

it('restores a URL-controlled table sort without remounting or moving missing dates ahead of known dates', () => {
  const items = [{ name: 'Beta', due: '2026-10-02' }, { name: 'Alpha', due: '2026-10-01' }, { name: 'Gamma', due: null }];
  const { result, rerender } = renderHook(({ key, dir }: { key: string; dir: 'asc' | 'desc' }) => useSort(items, { name: item => item.name, due: item => item.due }, 'due', 'asc', { key, dir }), { initialProps: { key: 'name', dir: 'asc' } });
  expect(result.current.sorted.map(item => item.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
  rerender({ key: 'due', dir: 'desc' });
  expect(result.current.sorted.map(item => item.name)).toEqual(['Beta', 'Alpha', 'Gamma']);
  expect(result.current.sortKey).toBe('due');
});
