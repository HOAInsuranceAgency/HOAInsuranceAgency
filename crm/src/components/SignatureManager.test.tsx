import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ update: vi.fn(), getUrl: vi.fn(), uploadData: vi.fn(), remove: vi.fn() }));
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ models: { UserProfile: { update: h.update } } }) }));
vi.mock('../lib/scopedStorage', () => ({ getUrl: h.getUrl, uploadData: h.uploadData, remove: h.remove }));
import SignatureManager from './SignatureManager';
import type { UserProfile } from '../lib/client';
const profile = { id: 'p1', firstName: 'Pat', lastName: 'Lee', signatureKey: 'signatures/p1.png' } as UserProfile;
function Harness() { const [value, setValue] = useState(profile); return <SignatureManager profile={value} onChange={setValue} />; }
beforeEach(() => { vi.clearAllMocks(); h.getUrl.mockResolvedValue({ url: new URL('https://example.com/signature') }); h.remove.mockResolvedValue({}); });

it('keeps the stored signature on a rejected removal and allows retry', async () => {
  h.update.mockResolvedValueOnce({ errors: [{ message: 'Profile unavailable' }] }).mockResolvedValueOnce({ data: { ...profile, signatureKey: null } });
  render(<Harness />); await screen.findByAltText('signature');
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Profile unavailable');
  expect(screen.getByAltText('signature')).toBeVisible();
  expect(h.remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  expect(await screen.findByText('None on file')).toBeVisible();
  expect(h.remove).toHaveBeenCalledWith({ path: profile.signatureKey });
});

it('ignores a preview response after the signature has been removed', async () => {
  let finish!: (value: unknown) => void;
  h.getUrl.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  h.update.mockResolvedValue({ data: { ...profile, signatureKey: null } });
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  await screen.findByText('None on file');
  await act(async () => finish({ url: new URL('https://example.com/old-signature') }));
  expect(screen.queryByAltText('signature')).toBeNull();
});

it('ignores an earlier profile preview after switching the signature subject', async () => {
  let finish!: (value: unknown) => void;
  h.getUrl.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<SignatureManager profile={profile} onChange={vi.fn()} />);
  view.rerender(<SignatureManager profile={{ ...profile, id: 'p2', signatureKey: 'signatures/p2.png' }} onChange={vi.fn()} />);
  await waitFor(() => expect(screen.getByAltText('signature')).toHaveAttribute('src', 'https://example.com/signature'));
  await act(async () => finish({ url: new URL('https://example.com/old-signature') }));
  expect(screen.getByAltText('signature')).toHaveAttribute('src', 'https://example.com/signature');
});
