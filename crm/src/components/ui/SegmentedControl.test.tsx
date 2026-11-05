import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { SegmentedControl, SegmentedRadioControl } from './SegmentedControl';

it('uses pressed filter buttons and preserves arrow-key list filtering', async () => {
  const user = userEvent.setup();
  function Filters() {
    const [value, onChange] = useState('active');
    return <SegmentedControl label="Lead views" value={value} onChange={onChange} rovingFocus items={[
      { value: 'active', label: 'Active', count: 12 }, { value: 'disabled', label: 'Disabled', disabled: true }, { value: 'all', label: 'All' },
    ]} />;
  }
  render(<Filters />);
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  expect(screen.getByRole('group', { name: 'Lead views' })).toBeInTheDocument();
  const active = screen.getByRole('button', { name: 'Active' }), all = screen.getByRole('button', { name: 'All' });
  await user.tab();
  expect(active).toHaveFocus();
  await user.keyboard('{ArrowRight}');
  expect(all).toHaveFocus();
  expect(all).toHaveAttribute('aria-pressed', 'true');
  expect(active).toHaveAttribute('aria-pressed', 'false');
  await user.keyboard('{Home}');
  expect(active).toHaveFocus();
  await user.keyboard('{ArrowLeft}');
  expect(all).toHaveFocus();
  await user.keyboard('{End}');
  expect(all).toHaveFocus();
});

it('supports a disabled filter and does not submit a form', () => {
  const change = vi.fn(), submit = vi.fn(event => event.preventDefault());
  const { rerender } = render(<form onSubmit={submit}><SegmentedControl label="Filter" value="all" onChange={change} disabled items={[{ value: 'all', label: 'All' }]} /></form>);
  fireEvent.click(screen.getByRole('button', { name: 'All' }));
  expect(change).not.toHaveBeenCalled();
  rerender(<form onSubmit={submit}><SegmentedControl label="Filter" value="all" onChange={change} items={[{ value: 'all', label: 'All' }]} /></form>);
  fireEvent.click(screen.getByRole('button', { name: 'All' }));
  expect(change).toHaveBeenCalledWith('all');
  expect(submit).not.toHaveBeenCalled();
});

it('retains native radio values and lets a selected yes/no answer be cleared', async () => {
  const user = userEvent.setup();
  function Answer() {
    const [value, onChange] = useState('');
    return <form aria-label="Answer"><SegmentedRadioControl label="Confirmed" name="confirmed" value={value} onChange={onChange} allowEmpty
      items={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} /></form>;
  }
  render(<Answer />);
  const yes = screen.getByRole('radio', { name: 'Yes' });
  await user.click(yes);
  expect(yes).toBeChecked();
  expect(new FormData(screen.getByRole('form', { name: 'Answer' }) as HTMLFormElement).get('confirmed')).toBe('yes');
  await user.click(yes);
  expect(yes).not.toBeChecked();
  expect(new FormData(screen.getByRole('form', { name: 'Answer' }) as HTMLFormElement).get('confirmed')).toBeNull();
  await user.click(screen.getByRole('radio', { name: 'No' }));
  expect(screen.getByRole('radio', { name: 'No' })).toBeChecked();
});
