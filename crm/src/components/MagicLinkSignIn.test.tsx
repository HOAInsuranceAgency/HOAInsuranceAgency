import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
const signIn = vi.hoisted(() => vi.fn());
vi.mock('aws-amplify/auth', () => ({ signIn, confirmSignIn: vi.fn() }));
import MagicLinkSignIn from './MagicLinkSignIn';

it('sends only one sign-in request while a request is pending', async () => {
  let finish!: () => void;
  signIn.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  render(<MagicLinkSignIn />);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'person@example.test' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(signIn).toHaveBeenCalledTimes(1);
  expect(input).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
  await act(async () => finish());
  expect(screen.getByText('person@example.test')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Use a different email/ }));
  expect(screen.getByRole('textbox')).toBeEnabled();
});

it('recovers from a malformed encoded link without crashing sign-in', () => {
  window.history.replaceState(null, '', '/#magic=%broken');
  render(<MagicLinkSignIn />);
  expect(screen.getByText('That sign-in link is malformed. Request a new one.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Email me a sign-in link' })).toBeInTheDocument();
});
