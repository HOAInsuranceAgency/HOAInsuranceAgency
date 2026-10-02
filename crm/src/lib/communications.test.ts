import { beforeEach, expect, it, vi } from 'vitest';
import { AccessDenied } from '../../amplify/functions/crm-access/policy';
import { isAuthorizationError } from './authorizationError';

const api = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('./client', () => ({ client: {
  queries: { communicationRead: api.read },
  mutations: { communicationWrite: api.write },
} }));
import { communicationRequest } from './communications';

beforeEach(() => { api.read.mockReset(); api.write.mockReset(); });

it.each([false, true])('preserves GraphQL authorization metadata, including later errors (write: %s)', async write => {
  const call = write ? api.write : api.read;
  call.mockResolvedValue({ data: null, errors: [
    { message: 'A different field timed out', errorType: 'Timeout' },
    { message: 'The requested operation failed', errorType: 'Unauthorized' },
  ] });
  const error = await communicationRequest('context', { accountId: 'a' }, write).catch(error => error);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ message: 'The requested operation failed' });
  expect(isAuthorizationError(error)).toBe(true);
});

it('recognizes the actual account guard message after Lambda strips its type', async () => {
  api.read.mockResolvedValue({ errors: [{ message: new AccessDenied().message }] });
  const error = await communicationRequest('context').catch(error => error);
  expect(isAuthorizationError(error)).toBe(true);
});

it.each(['UnauthorizedException', 'NotAuthorizedException', 'UserUnAuthenticatedException', 'AccessDeniedException', 'Forbidden', 'NoSignedUser', 'NoValidAuthTokens'])('recognizes SDK %s errors without relying on the message', async name => {
  const denied = Object.assign(new Error('Request failed'), { name });
  api.read.mockRejectedValue(denied);
  const error = await communicationRequest('context').catch(error => error);
  expect(error).toBe(denied);
  expect(isAuthorizationError(error)).toBe(true);
});

it('normalizes rejected GraphQL authorization envelopes to a readable error', async () => {
  api.read.mockRejectedValue({ errors: [{ errorType: 'Unauthorized', message: 'Request failed' }] });
  const error = await communicationRequest('context').catch(error => error);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ message: "You don't have permission to do that." });
  expect(isAuthorizationError(error)).toBe(true);
});

it.each(['Network error', 'Refresh unavailable', 'Account access lookup is busy; please retry'])('keeps transient failures distinct: %s', async message => {
  api.read.mockResolvedValue({ errors: [{ message, errorType: 'Timeout' }] });
  const error = await communicationRequest('context').catch(error => error);
  expect(error).toMatchObject({ message });
  expect(isAuthorizationError(error)).toBe(false);
});

it('still decodes successful communication responses', async () => {
  api.read.mockResolvedValue({ data: JSON.stringify({ ok: true, workflow: null }) });
  await expect(communicationRequest('context')).resolves.toEqual({ ok: true, workflow: null });
});
