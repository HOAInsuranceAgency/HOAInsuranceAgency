import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { signIn, signInWithRedirect, confirmSignIn, config, hub } = vi.hoisted(() => ({
  signIn: vi.fn(),
  signInWithRedirect: vi.fn(),
  confirmSignIn: vi.fn(),
  config: { providers: [] as string[] },
  hub: { listener: (_: { payload: { event: string; data?: unknown } }) => {} },
}));
vi.mock('aws-amplify/auth', () => ({ signIn, signInWithRedirect, confirmSignIn }));
vi.mock('aws-amplify', () => ({ Amplify: {
  getConfig: () => ({ Auth: { Cognito: { loginWith: { oauth: { providers: config.providers } } } } }),
} }));
vi.mock('aws-amplify/utils', () => ({ Hub: { listen: (_: string, listener: typeof hub.listener) => {
  hub.listener = listener;
  return () => {};
} } }));
import MagicLinkSignIn from './MagicLinkSignIn';
import { clearGoogleSignInError, GOOGLE_SIGN_IN_ERROR, listenForGoogleSignInFailures } from '../lib/googleSignIn';

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  signIn.mockReset();
  signInWithRedirect.mockReset();
  confirmSignIn.mockReset();
  config.providers = [];
  clearGoogleSignInError();
  listenForGoogleSignInFailures();
});
afterEach(() => vi.unstubAllEnvs());

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

it('keeps email sign-in available when Google is not configured', () => {
  render(<MagicLinkSignIn />);
  expect(screen.queryByRole('button', { name: 'Continue with Google' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Email me a sign-in link' })).toBeInTheDocument();
});

it('does not open OAuth in the embedded Front sidebar', () => {
  config.providers = ['Google'];
  render(<MagicLinkSignIn embedded />);
  expect(screen.queryByRole('button', { name: 'Continue with Google' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Email me a sign-in link' })).toBeInTheDocument();
});

it('opens Google once and prevents an email session racing the redirect', async () => {
  config.providers = ['Google'];
  signInWithRedirect.mockResolvedValue(undefined);
  render(<MagicLinkSignIn />);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'person@example.test' } });
  const googleButton = screen.getByRole('button', { name: 'Continue with Google' });
  await act(async () => {
    fireEvent.click(googleButton);
    fireEvent.click(googleButton);
    fireEvent.keyDown(input, { key: 'Enter' });
  });
  expect(signInWithRedirect).toHaveBeenCalledExactlyOnceWith({ provider: 'Google' });
  expect(signIn).not.toHaveBeenCalled();
  expect(confirmSignIn).not.toHaveBeenCalled();
  expect(input).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Opening Google…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Email me a sign-in link' })).toBeDisabled();
});

it('does not start Google while an email sign-in request is pending', async () => {
  config.providers = ['Google'];
  let finish!: () => void;
  signIn.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  render(<MagicLinkSignIn />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'person@example.test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
  const googleButton = screen.getByRole('button', { name: 'Continue with Google' });
  expect(googleButton).toBeDisabled();
  fireEvent.click(googleButton);
  expect(signInWithRedirect).not.toHaveBeenCalled();
  await act(async () => finish());
});

it('recovers safely from a failed Google redirect and allows a retry', async () => {
  config.providers = ['Google'];
  signInWithRedirect.mockRejectedValueOnce(new Error('private provider details'));
  render(<MagicLinkSignIn />);
  fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(GOOGLE_SIGN_IN_ERROR);
  expect(screen.queryByText('private provider details')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox')).toBeEnabled();
  signInWithRedirect.mockResolvedValueOnce(undefined);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' })));
  expect(signInWithRedirect).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('retains callback failures before React mounts and removes OAuth details from the URL', () => {
  config.providers = ['Google'];
  window.history.replaceState(null, '', '/?error=access_denied&error_description=private&state=oauth-state&code=private-code&keep=value');
  hub.listener({ payload: { event: 'signInWithRedirect_failure', data: { error: 'private' } } });
  render(<MagicLinkSignIn />);
  expect(screen.getByRole('alert')).toHaveTextContent(GOOGLE_SIGN_IN_ERROR);
  expect(window.location.search).toBe('?keep=value');
});

it('unlocks sign-in methods when a pending Google flow fails through Hub', async () => {
  config.providers = ['Google'];
  signInWithRedirect.mockResolvedValueOnce(undefined);
  render(<MagicLinkSignIn />);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' })));
  await act(async () => hub.listener({ payload: { event: 'signInWithRedirect_failure' } }));
  expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
  expect(screen.getByRole('textbox')).toBeEnabled();
  expect(screen.getByRole('alert')).toHaveTextContent(GOOGLE_SIGN_IN_ERROR);
});

it('preserves the explicit destination email request and locks Google until it finishes', async () => {
  vi.stubEnv('VITE_HOA_MIGRATION_AUTH', 'true');
  config.providers = ['Google'];
  signIn.mockResolvedValue({ nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE' } });
  let finish!: () => void;
  confirmSignIn.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  render(<MagicLinkSignIn />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), { target: { value: 'jake@getgim.com' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' })));
  expect(confirmSignIn).toHaveBeenCalledExactlyOnceWith({ challengeResponse: 'REQUEST_LINK' });
  const googleButton = screen.getByRole('button', { name: 'Continue with Google' });
  expect(googleButton).toBeDisabled();
  fireEvent.click(googleButton);
  expect(signInWithRedirect).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(screen.getByText('jake@getgim.com')).toBeInTheDocument();
});

it('keeps Google and email disabled when administrator preview sign-in is off', () => {
  vi.stubEnv('VITE_HOA_MIGRATION_PREVIEW', 'true');
  vi.stubEnv('VITE_HOA_MIGRATION_AUTH', 'true');
  vi.stubEnv('VITE_HOA_PREVIEW_ADMIN_LOGIN', 'false');
  config.providers = ['Google'];
  render(<MagicLinkSignIn />);
  expect(screen.getByText(/Administrator sign-in and email are disabled/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Continue with Google' })).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(signInWithRedirect).not.toHaveBeenCalled();
  expect(signIn).not.toHaveBeenCalled();
});

it('rechecks preview expiry before starting a Google redirect', () => {
  vi.stubEnv('VITE_HOA_MIGRATION_PREVIEW', 'true');
  vi.stubEnv('VITE_HOA_MIGRATION_AUTH', 'true');
  vi.stubEnv('VITE_HOA_PREVIEW_ADMIN_LOGIN', 'true');
  vi.stubEnv('VITE_HOA_PREVIEW_ADMIN_LOGIN_EXPIRES_AT', '2099-01-01T00:00:00Z');
  config.providers = ['Google'];
  render(<MagicLinkSignIn />);
  const googleButton = screen.getByRole('button', { name: 'Continue with Google' });
  vi.stubEnv('VITE_HOA_PREVIEW_ADMIN_LOGIN_EXPIRES_AT', '2020-01-01T00:00:00Z');
  fireEvent.click(googleButton);
  expect(signInWithRedirect).not.toHaveBeenCalled();
});
