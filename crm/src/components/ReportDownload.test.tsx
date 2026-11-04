import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { DashboardReport } from '../lib/reportDownload';
const h = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('../lib/reportDownload', async original => ({ ...await original<typeof import('../lib/reportDownload')>(), saveReport: h.save }));
import { ReportDownload } from './ReportDownload';

const displayed: DashboardReport = { title: 'Leads', sections: [{ title: 'Leads', columns: ['Name'], rows: [['First page']] }] };
const complete: DashboardReport = { ...displayed, sections: [{ ...displayed.sections[0], rows: [['First page'], ['Last authorized page']] }] };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function printWindow() {
  return { opener: window, closed: false, close: vi.fn(), focus: vi.fn(), document: { open: vi.fn(), write: vi.fn(), close: vi.fn() } };
}
beforeEach(() => { h.save.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

it('preserves synchronous existing caller downloads', () => {
  render(<ReportDownload report={displayed} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Download Leads' }), { target: { value: 'csv' } });
  expect(h.save).toHaveBeenCalledExactlyOnceWith(displayed, expect.objectContaining({ asOf: expect.any(Date) }), 'csv');
});

it('opens PDF during the user gesture, removes opener and waits for the complete authorized report', async () => {
  const pending = deferred<DashboardReport>(), win = printWindow(), order: string[] = [];
  const open = vi.spyOn(window, 'open').mockImplementation(() => { order.push('open'); return win as unknown as Window; });
  const loader = vi.fn(() => { order.push('load'); return pending.promise; });
  render(<ReportDownload report={displayed} loadReport={loader} />);
  const select = screen.getByRole('combobox', { name: 'Download Leads' });
  fireEvent.change(select, { target: { value: 'pdf' } });
  expect(order).toEqual(['open', 'load']); expect(win.opener).toBeNull();
  expect(select).toBeDisabled(); expect(screen.getByRole('status')).toHaveTextContent('Preparing full report');
  expect(h.save).not.toHaveBeenCalled();
  fireEvent.change(select, { target: { value: 'pdf' } });
  expect(loader).toHaveBeenCalledTimes(1); expect(open).toHaveBeenCalledTimes(1);
  await act(async () => { pending.resolve(complete); });
  expect(h.save).toHaveBeenCalledExactlyOnceWith(complete, expect.any(Object), 'pdf', win);
  expect(win.close).not.toHaveBeenCalled(); expect(select).toBeEnabled();
});

it('waits for full CSV data without opening a window and allows retry after failure', async () => {
  const pending = deferred<DashboardReport>(), open = vi.spyOn(window, 'open');
  const loader = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(complete);
  render(<ReportDownload report={displayed} loadReport={loader} />);
  const select = screen.getByRole('combobox', { name: 'Download Leads' });
  fireEvent.change(select, { target: { value: 'csv' } });
  expect(open).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled();
  await act(async () => { pending.reject(new Error('Access changed. Refresh the report.')); });
  expect(screen.getByRole('alert')).toHaveTextContent('Access changed'); expect(select).toBeEnabled();
  fireEvent.change(select, { target: { value: 'csv' } });
  await waitFor(() => expect(h.save).toHaveBeenCalledExactlyOnceWith(complete, expect.any(Object), 'csv'));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('closes the pending PDF window when full report loading fails', async () => {
  const pending = deferred<DashboardReport>(), win = printWindow();
  vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
  render(<ReportDownload report={displayed} loadReport={() => pending.promise} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'pdf' } });
  await act(async () => { pending.reject(new Error('The active role changed.')); });
  expect(win.close).toHaveBeenCalledTimes(1); expect(h.save).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('active role changed');
});

it('does not fetch a report when the PDF popup is blocked', () => {
  vi.spyOn(window, 'open').mockReturnValue(null); const loader = vi.fn();
  render(<ReportDownload report={displayed} loadReport={loader} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'pdf' } });
  expect(loader).not.toHaveBeenCalled(); expect(screen.getByRole('alert')).toHaveTextContent('pop-up');
  expect(screen.getByRole('combobox')).toBeEnabled();
});

it('closes a pending print window on navigation and suppresses its late result', async () => {
  const pending = deferred<DashboardReport>(), win = printWindow();
  vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
  const page = render(<ReportDownload report={displayed} loadReport={() => pending.promise} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'pdf' } });
  page.unmount(); expect(win.close).toHaveBeenCalledTimes(1);
  await act(async () => { pending.resolve(complete); });
  expect(h.save).not.toHaveBeenCalled();
});
