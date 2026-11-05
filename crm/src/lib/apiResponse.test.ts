import { describe, expect, it, vi } from 'vitest';
import { ApiResponseError, apiFailure, decodeApiRecord, decodeApiResponse } from '../../../shared/apiResponse';
import { privateApiError, privateApiRecord } from './apiResponse';
import { isAuthorizationError } from '../../../shared/authorizationError';
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ models: {} }) }));
import { assertNoErrors, unwrap } from './client';

describe('API wire contracts', () => {
  it.each([(value: unknown) => value, JSON.stringify, (value: unknown) => JSON.stringify(JSON.stringify(value))])('decodes AWSJSON without changing its result', encode => {
    expect(decodeApiRecord({ data: encode({ ok: true, amount: 0 }) }, { fallback: 'Failed' })).toEqual({ ok: true, amount: 0 });
  });
  it.each([null, [], 3, 'bad json', JSON.stringify('still not json')])('rejects an unreadable response without echoing raw data: %j', data => {
    expect(() => decodeApiRecord({ data }, { fallback: 'Safe failure' })).toThrow('Safe failure');
  });
  it('preserves every GraphQL classification and prioritizes denial even after a transient error', () => {
    let failure: unknown;
    try { privateApiRecord({ errors: [{ message: 'Temporary outage' }, { message: 'Request failed', errorType: 'Unauthorized', code: 'REVOKED', extensions: { secret: 'not retained' } }] }, { fallback: 'Failed' }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ApiResponseError);
    expect(failure).toMatchObject({ name: 'Unauthorized', message: 'Temporary outage; Request failed', origin: 'graphql', errorType: 'Unauthorized', errors: [{ message: 'Temporary outage' }, { message: 'Request failed', errorType: 'Unauthorized', code: 'REVOKED' }] });
    expect(failure).not.toHaveProperty('code');
    expect(isAuthorizationError(failure)).toBe(true);
    expect(JSON.stringify(failure)).not.toContain('not retained');
  });
  it('keeps business idempotency rejection codes and authorization envelopes', () => {
    expect(() => privateApiRecord({ data: JSON.stringify({ ok: false, error: 'Review the changed quote', code: 'BUSINESS_DRAFT_NOT_DISPATCHED' }) }, { fallback: 'Failed' })).toThrow(expect.objectContaining({ code: 'BUSINESS_DRAFT_NOT_DISPATCHED' }));
    expect(() => privateApiRecord({ data: { ok: false, error: 'Inactive account', errorType: 'Unauthorized' } }, { fallback: 'Failed' })).toThrow(expect.objectContaining({ name: 'Unauthorized' }));
  });
  it.each([undefined, null, 0, 'false'])('does not accept a malformed ok flag as proof of nondispatch: %j', ok => {
    expect(() => privateApiRecord({ data: { ok, error: 'Unknown outcome', code: 'BUSINESS_DRAFT_NOT_DISPATCHED' } }, { fallback: 'Could not confirm the response' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_API_RESPONSE', origin: 'protocol' }));
  });
  it('normalizes rejected GraphQL envelopes without losing their error evidence', () => {
    expect(() => privateApiError({ errors: [{ message: 'First error' }, { message: 'Inactive', errorType: 'Unauthorized' }] })).toThrow(expect.objectContaining({ name: 'Unauthorized', errors: [{ message: 'First error' }, { message: 'Inactive', errorType: 'Unauthorized' }] }));
  });
  it('does not trust application-looking codes on an SDK rejection', () => {
    const rejected = new ApiResponseError('Unknown delivery outcome', { origin: 'application', code: 'BUSINESS_DRAFT_NOT_DISPATCHED' });
    try { privateApiError(rejected); } catch (error) {
      expect(error).toMatchObject({ origin: 'transport', errors: [{ message: 'Unknown delivery outcome', code: 'BUSINESS_DRAFT_NOT_DISPATCHED' }] });
      expect(error).not.toHaveProperty('code');
    }
  });
  it('supports no-ok file contracts while refusing an explicit failed response', () => {
    expect(decodeApiRecord({ data: { url: 'https://example.test/file', expiresAt: '2030-01-01' } }, { requireOk: false, fallback: 'File failed' })).toHaveProperty('url');
    expect(() => decodeApiRecord({ data: { ok: false, error: 'File unavailable' } }, { requireOk: false, fallback: 'File failed' })).toThrow('File unavailable');
  });
  it('lets a feature require its own result shape', () => {
    const invoiceNumber = (value: Record<string, unknown>): value is { invoiceNumber: string } => typeof value.invoiceNumber === 'string' && !!value.invoiceNumber;
    expect(decodeApiResponse({ data: '{"invoiceNumber":"INV-1"}' }, invoiceNumber, { requireOk: false, fallback: 'Counter failed' })).toEqual({ invoiceNumber: 'INV-1' });
    expect(() => decodeApiResponse({ data: {} }, invoiceNumber, { requireOk: false, fallback: 'Counter failed' })).toThrow('Counter failed');
  });
  it('keeps nullable optional reads and already-absent deletes distinct from required entity reads', () => {
    expect(() => assertNoErrors({ data: null } as { errors?: { message: string }[] })).not.toThrow();
    expect(() => unwrap({ data: null })).toThrow('returned nothing');
    expect(() => unwrap({ data: null, errors: [{ message: 'Inactive', errorType: 'Unauthorized' } as { message: string }] })).toThrow(expect.objectContaining({ name: 'Unauthorized' }));
  });
  it('constructs additive failure metadata without copying arbitrary properties', () => {
    expect(apiFailure(Object.assign(new Error('Review required'), { code: 'REVIEW', privateKey: 'secret' }), 'Failed')).toEqual({ ok: false, error: 'Review required', code: 'REVIEW' });
  });
});
