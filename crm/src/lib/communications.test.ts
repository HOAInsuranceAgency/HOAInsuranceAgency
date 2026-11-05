import { beforeEach, expect, it, vi } from 'vitest';
import { AccessDenied } from '../../amplify/functions/crm-access/policy';
import { isAuthorizationError } from '../../../shared/authorizationError';

const api = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('./client', () => ({ client: {
  queries: { communicationRead: api.read },
  mutations: { communicationWrite: api.write },
} }));
import { communicationRequest } from './communications';

const draftInput = { accountId: 'a', previewId: 'preview', previewHash: 'hash', requestId: 'request', to: ['board@example.test'], cc: [] };

beforeEach(() => { api.read.mockReset(); api.write.mockReset(); });

it.each([false, true])('preserves GraphQL authorization metadata, including later errors (write: %s)', async write => {
  const call = write ? api.write : api.read;
  call.mockResolvedValue({ data: null, errors: [
    { message: 'A different field timed out', errorType: 'Timeout' },
    { message: 'The requested operation failed', errorType: 'Unauthorized' },
  ] });
  const error = await (write ? communicationRequest('setResponsibilities', { accountId: 'a', salespersonId: 'owner', version: 1 }, true) : communicationRequest('context', { accountId: 'a' })).catch(error => error);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ message: 'A different field timed out; The requested operation failed' });
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
  expect(error).toMatchObject({ name: 'Unauthorized', origin: 'transport' });
  expect(isAuthorizationError(error)).toBe(true);
});

it('normalizes rejected GraphQL authorization envelopes to a readable error', async () => {
  api.read.mockRejectedValue({ errors: [{ errorType: 'Unauthorized', message: 'Request failed' }] });
  const error = await communicationRequest('context').catch(error => error);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ message: "Request failed", origin: "transport" });
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

it.each([false, true])('preserves only the explicit pre-dispatch code from a Lambda application response (JSON: %s)', async encoded => {
  const result = { ok: false, error: 'The quote changed. Review a new preview', code: 'BUSINESS_DRAFT_NOT_DISPATCHED' };
  api.write.mockResolvedValue({ data: encoded ? JSON.stringify(result) : result });
  const error = await communicationRequest('prepareBusinessDraft', draftInput, true).catch(error => error);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ message: result.error, code: 'BUSINESS_DRAFT_NOT_DISPATCHED' });
  expect(isAuthorizationError(error)).toBe(false);
});

it.each(['BUSINESS_DRAFT_CONFLICT', 'NETWORK_FAILURE', 'business_draft_not_dispatched'])('preserves application code %s without classifying it as an editable draft rejection', async code => {
  api.write.mockResolvedValue({ data: JSON.stringify({ ok: false, error: 'This request needs review', code }) });
  const error = await communicationRequest('prepareBusinessDraft', draftInput, true).catch(error => error);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ code, origin: 'application' });
  expect(error).not.toMatchObject({ code: 'BUSINESS_DRAFT_NOT_DISPATCHED' });
});

it('does not copy a pre-dispatch-looking code from a GraphQL transport error', async () => {
  api.write.mockResolvedValue({ errors: [{ message: 'Transport failed', code: 'BUSINESS_DRAFT_NOT_DISPATCHED' }] });
  const error = await communicationRequest('prepareBusinessDraft', draftInput, true).catch(error => error);
  expect(error).toMatchObject({ message: 'Transport failed' });
  expect(error).not.toHaveProperty('code');
});
