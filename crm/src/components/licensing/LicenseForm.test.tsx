import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import LicenseForm from './LicenseForm';
import type { UserProfile } from '../../lib/client';
import type { ModelData } from '../../../fixtures/builders';

const h = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ models: { License: h } }) }));

const profiles = [{ id: 'member', userId: 'member-user', firstName: 'Alex', lastName: 'Taylor',
  email: 'alex@example.test', role: 'PRODUCER', onboardingComplete: true,
  createdAt: '2026-09-14T13:00:00Z', updatedAt: '2026-09-14T13:00:00Z' }] satisfies ModelData<UserProfile>[];
beforeEach(() => { vi.resetAllMocks(); });

it('saves a producer license through labeled controls while retaining date validation and authority choices', async () => {
  h.create.mockResolvedValue({ data: { id: 'saved' } });
  const onSaved = vi.fn();
  // Persisted list rows have no SDK lazy loader; this form reads only the checked scalar data.
  render(<LicenseForm holderType="PRODUCER" existing={null} profiles={profiles as UserProfile[]} onSaved={onSaved} onCancel={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Team member *'), { target: { value: 'member' } });
  fireEvent.change(screen.getByLabelText('State *'), { target: { value: 'MA' } });
  fireEvent.change(screen.getByLabelText('License number *'), { target: { value: ' TEST-123 ' } });
  fireEvent.change(screen.getByLabelText('Effective date'), { target: { value: '2027-02-01' } });
  fireEvent.change(screen.getByLabelText('Expiration date'), { target: { value: '2027-01-01' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add license' }));
  expect(screen.getByRole('alert')).toHaveTextContent("Effective date can't be after the expiration date.");
  expect(h.create).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Expiration date'), { target: { value: '2028-01-01' } });
  fireEvent.click(screen.getByLabelText('Property'));
  fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Fictional renewal note' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add license' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(h.create).toHaveBeenCalledWith(expect.objectContaining({
    holderType: 'PRODUCER', userProfileId: 'member', holderName: 'Alex Taylor', state: 'MA', licenseNumber: 'TEST-123',
    effectiveDate: '2027-02-01', expirationDate: '2028-01-01', linesOfAuthority: ['Property'], notes: 'Fictional renewal note',
  }));
});

it('keeps the draft and single-flight fieldset lock through a failed save and permits the existing retry', async () => {
  let reject!: (error: Error) => void;
  h.create.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; })).mockResolvedValue({ data: { id: 'saved' } });
  const onSaved = vi.fn(), onSaving = vi.fn();
  render(<LicenseForm holderType="FIRM" existing={null} profiles={[]} onSaved={onSaved} onSaving={onSaving} onCancel={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('State *'), { target: { value: 'MA' } });
  const number = screen.getByLabelText('License number *');
  fireEvent.change(number, { target: { value: 'FIRM-TEST' } });
  const save = screen.getByRole('button', { name: 'Add license' });
  act(() => { fireEvent.click(save); fireEvent.click(save); });
  expect(h.create).toHaveBeenCalledOnce();
  expect(number).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await act(async () => reject(new Error('License save unavailable')));
  expect(screen.getByRole('alert')).toHaveTextContent('License save unavailable');
  expect(number).toHaveValue('FIRM-TEST');
  expect(number).toBeEnabled();
  expect(onSaved).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Add license' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(onSaving.mock.calls).toEqual([[true], [false], [true], [false]]);
});
