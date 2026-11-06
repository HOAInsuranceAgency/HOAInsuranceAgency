import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountAccess, type Reader } from '../../amplify/functions/crm-access/access';
import { AccessDenied, type Identity, type RecordData } from '../../amplify/functions/crm-access/policy';

let records: Map<string, RecordData>;
const reader = vi.fn<Reader>(async (model, key) => records.get(`${model}:${key}`));
const identities: { label: string; identity: Identity }[] = [
  { label: 'assigned salesperson', identity: { sub: 'alice' } },
  { label: 'Admin', identity: { sub: 'admin', groups: ['ADMIN'] } },
  { label: 'Owner', identity: { sub: 'owner', groups: ['OWNER'] } },
];
const createInput = { id: 'new', entityType: 'ACCOUNT', entityId: 'a', name: '_scan.pdf', s3Key: 'pending' };

beforeEach(() => {
  reader.mockClear();
  records = new Map([
    ['Account:a', { id: 'a' }], ['Account:b', { id: 'b' }],
    ['Communication:workflow:a', { data: { salespersonId: 'alice' } }],
    ['Communication:workflow:b', { data: { salespersonId: 'bob' } }],
    ['Document:uploaded', { id: 'uploaded', entityType: 'ACCOUNT', entityId: 'a', name: '_scan.pdf', uploadedName: '_scan.pdf', s3Key: 'pending' }],
    ['Document:legacy', { id: 'legacy', entityType: 'ACCOUNT', entityId: 'a', name: 'Generated policy.pdf', s3Key: 'pending' }],
  ]);
});

describe.each(identities)('uploaded filename provenance for $label', ({ identity }) => {
  const access = () => new AccountAccess(identity, reader);

  it('accepts an original filename exactly matching the initial display name', async () => {
    await expect(access().write('Document', 'create', { ...createInput, uploadedName: '_scan.pdf' })).resolves.toBeUndefined();
  });

  it.each([undefined, null])('preserves optional legacy provenance on create (%s)', async uploadedName => {
    const input = uploadedName === undefined ? createInput : { ...createInput, uploadedName };
    await expect(access().write('Document', 'create', input)).resolves.toBeUndefined();
  });

  it.each(['scan.pdf', 123])('rejects mismatched or invalid creation provenance (%s)', async uploadedName => {
    await expect(access().write('Document', 'create', { ...createInput, uploadedName })).rejects.toThrow();
  });

  it('allows a manual rename while repeating unchanged provenance', async () => {
    await expect(access().write('Document', 'update', { id: 'uploaded', name: 'scan.pdf', uploadedName: '_scan.pdf' })).resolves.toBeUndefined();
  });

  it('allows ordinary updates that omit provenance', async () => {
    await expect(access().write('Document', 'update', { id: 'uploaded', name: 'Reviewed budget.pdf' })).resolves.toBeUndefined();
  });

  it.each(['scan.pdf', null])('rejects changing or clearing stored provenance (%s)', async uploadedName => {
    await expect(access().write('Document', 'update', { id: 'uploaded', uploadedName })).rejects.toThrow();
  });

  it('rejects adding provenance to an existing legacy row', async () => {
    await expect(access().write('Document', 'update', { id: 'legacy', uploadedName: 'Generated policy.pdf' })).rejects.toThrow();
  });

  it.each([undefined, null])('allows legacy generated rows to rename with absent metadata (%s)', async uploadedName => {
    const input: RecordData = { id: 'legacy', name: 'Reviewed policy.pdf' };
    if (uploadedName === null) input.uploadedName = null;
    await expect(access().write('Document', 'update', input)).resolves.toBeUndefined();
  });

  it('uses one request-cached Document read for unchanged provenance and authorization', async () => {
    await expect(access().write('Document', 'update', { id: 'uploaded', uploadedName: '_scan.pdf' })).resolves.toBeUndefined();
    expect(reader.mock.calls.filter(([model, key]) => model === 'Document' && key === 'uploaded')).toHaveLength(1);
  });
});

describe('upload provenance preserves account authorization', () => {
  it('does not let matching provenance authorize a different account on create', async () => {
    const access = new AccountAccess({ sub: 'alice' }, reader);
    await expect(access.write('Document', 'create', { ...createInput, entityId: 'b', uploadedName: '_scan.pdf' })).rejects.toBeInstanceOf(AccessDenied);
  });

  it('does not let unchanged provenance reparent an existing document', async () => {
    const access = new AccountAccess({ sub: 'alice' }, reader);
    await expect(access.write('Document', 'update', { id: 'uploaded', entityId: 'b', uploadedName: '_scan.pdf' })).rejects.toBeInstanceOf(AccessDenied);
  });
});
