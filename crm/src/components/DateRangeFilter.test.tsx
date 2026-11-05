import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DateRangeFilter } from './DateRangeFilter';

afterEach(() => vi.useRealTimers());

it('applies calendar edits immediately and calculates presets on the day they are clicked', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-12-31T23:00:00-05:00'));
  function Report() {
    const [value, onChange] = useState({ from: '', to: '' });
    return <><DateRangeFilter value={value} onChange={onChange} allowOpenEnded /><output>{value.from}|{value.to}</output></>;
  }
  render(<Report />);
  fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-09-01' } });
  expect(screen.getByRole('status')).toHaveTextContent('2026-09-01|');
  expect(screen.queryByRole('button', { name: /Apply/ })).toBeNull();
  act(() => { vi.setSystemTime(new Date('2027-01-01T00:01:00-05:00')); });
  fireEvent.click(screen.getByRole('button', { name: 'Year to date' }));
  expect(screen.getByRole('status')).toHaveTextContent('2027-01-01|2027-01-01');
  expect(screen.getByRole('button', { name: 'Year to date' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'All time' }));
  expect(screen.getByRole('status')).toHaveTextContent('|');
});
