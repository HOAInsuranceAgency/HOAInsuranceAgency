import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { CarrierForm } from './CarrierForm';
import { carrier } from '../../../fixtures/builders';

const h = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ models: { Carrier: h } }) }));
beforeEach(() => { vi.resetAllMocks(); });

it('saves labeled appointment controls while retaining numeric conversion and native state choices', async () => {
  const saved = carrier({ name: 'Updated carrier' });
  h.update.mockResolvedValue({ data: saved });
  const onChange = vi.fn();
  render(<CarrierForm carrier={carrier()} onChange={onChange} />);
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Updated carrier ' } });
  fireEvent.change(screen.getByLabelText('Status'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('Standard commission % (autofills new quotes)'), { target: { value: '12.5' } });
  fireEvent.change(screen.getByLabelText('Annual minimum premium to maintain appointment ($)'), { target: { value: '50000' } });
  fireEvent.change(screen.getByLabelText('Contact email'), { target: { value: 'contact@example.test' } });
  fireEvent.click(screen.getByLabelText('MA'));
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(saved));
  expect(h.update).toHaveBeenCalledWith(expect.objectContaining({
    name: 'Updated carrier', appointed: true, standardCommissionPct: 12.5, annualMinimumPremium: 50000,
    primaryContactEmail: 'contact@example.test', states: ['MA'], dateAppointed: null,
  }));
});

it('preserves edits made during a save when the confirmed source is returned to the form', async () => {
  let resolve!: (value: { data: ReturnType<typeof carrier> }) => void;
  h.update.mockReturnValue(new Promise(done => { resolve = done; }));
  function Editor() {
    const [value, setValue] = useState(() => carrier());
    return <CarrierForm carrier={value} onChange={setValue} />;
  }
  render(<Editor />);
  const name = screen.getByLabelText('Name');
  fireEvent.change(name, { target: { value: 'Submitted name' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  fireEvent.change(name, { target: { value: 'New draft while saving' } });
  await act(async () => resolve({ data: carrier({ name: 'Submitted name' }) }));
  expect(screen.getByLabelText('Name')).toBe(name);
  expect(name).toHaveValue('New draft while saving');
  expect(h.update).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
});
