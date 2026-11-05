import { expect, expectTypeOf, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), commission: vi.fn() }));
vi.mock('./client', () => ({ client: { queries: { communicationRead: api.read }, mutations: { communicationWrite: api.write, commissionAction: api.commission } } }));
import { communicationRequest } from './communications';
import { commissionAction } from './commissions';
import type { TeamEligibility } from '../../../shared/leadWorkflow';

// Checked by the project's TypeScript build, never executed as business writes.
function compileTimeContracts() {
  expectTypeOf(communicationRequest('team')).resolves.toMatchTypeOf<{ team: TeamEligibility[] }>();
  // @ts-expect-error operation names are finite, not arbitrary strings
  communicationRequest('teem');
  // @ts-expect-error payload must correspond to this operation, not another valid operation
  communicationRequest('searchAccounts', { accountId: 'a' });
  // @ts-expect-error required operation payload cannot be omitted
  communicationRequest('searchAccounts');
  // @ts-expect-error read operations cannot use the write transport
  communicationRequest('team', {}, true);
  // @ts-expect-error writes require the explicit write transport
  communicationRequest('refreshSeen', { id: 'c' });
  // @ts-expect-error idempotency identity cannot be omitted from draft preparation
  communicationRequest('prepareBusinessDraft', { accountId: 'a', previewId: 'p', previewHash: 'h', to: [], cc: [] }, true);
  // @ts-expect-error callers cannot substitute arbitrary result types
  communicationRequest<{ invented: string }>('team');
  // @ts-expect-error the team result cannot be used as a file URL
  communicationRequest('team').then(result => result.url);
  // @ts-expect-error an unrelated operation payload cannot widen operation inference
  commissionAction('preparePayroll', { id: 'batch', version: 1, reference: 'r', payDate: '2026-11-05' });
  // @ts-expect-error wrong commission action is rejected
  commissionAction('payPayrol', { id: 'b', version: 1, reference: 'r', payDate: '2026-11-05' });
  // @ts-expect-error a file read has no upload key in its result
  commissionAction('file', { key: 'commission/file' }).then(result => result.key);
  expectTypeOf(commissionAction('file', { action: 'upload', size: 1, contentType: 'application/pdf', filename: 'statement.pdf' })).resolves.toEqualTypeOf<{ key: string; url: string }>();
}

it('keeps compile-time contracts attached to the real operation adapters', () => {
  expect(compileTimeContracts).toBeTypeOf('function');
});
it('refuses unknown operations and mismatched transports before any request', async () => {
  // JavaScript callers and stale bundles still receive a runtime transport guard.
  // @ts-expect-error exercising the runtime boundary with an unknown operation
  await expect(communicationRequest('constructor')).rejects.toMatchObject({ code: 'INVALID_API_OPERATION' });
  // @ts-expect-error exercising the runtime boundary with a mismatched transport
  await expect(communicationRequest('prepareBusinessDraft', {}, false)).rejects.toMatchObject({ code: 'INVALID_API_OPERATION' });
  // @ts-expect-error exercising the runtime boundary with an unknown operation
  await expect(commissionAction('constructor', {})).rejects.toMatchObject({ code: 'INVALID_API_OPERATION' });
  expect(api.read).not.toHaveBeenCalled();
  expect(api.write).not.toHaveBeenCalled();
  expect(api.commission).not.toHaveBeenCalled();
});
