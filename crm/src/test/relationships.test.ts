import { beforeEach, describe, expect, it, vi } from 'vitest';
import { relationshipCurrent, relationshipDates } from '../../../shared/relationships';
import { primaryContact, billingContact, inspectionContact } from '../lib/contacts';

const h = vi.hoisted(() => ({ records: new Map<string, Record<string, any>>(), commit: vi.fn(), fail: false }));
vi.mock('../../amplify/functions/crm-access/user-status', () => ({ assertUserSession: vi.fn(async () => {}), activeTeamUserCheck: () => ({ ConditionCheck: { TableName: 'UserAccess', Key: { userId: 'alice' } } }) }));
vi.mock('../../amplify/functions/communications/data', () => ({ dataClient: async () => ({ models: { AccountRelationship: { listAccountRelationshipByAccountId: async ({ accountId }: { accountId: string }) => ({ data: [...h.records].filter(([k, v]) => k.startsWith('AccountRelationship:') && v.accountId === accountId).map(([, v]) => v) }) } } }) }));
vi.mock('../../amplify/functions/communications/store', async original => {
  const actual = await original<typeof import('../../amplify/functions/communications/store')>();
  return { ...actual, get: async (id: string) => structuredClone(h.records.get(`Communication:${id}`)), db: { send: async (cmd: any) => cmd.input.RequestItems ? { Responses: Object.fromEntries(Object.entries(cmd.input.RequestItems).map(([table, request]: [string, any]) => [table, request.Keys.map((k: any) => structuredClone(h.records.get(`${table}:${k.id}`))).filter(Boolean)])) } : ({ Item: structuredClone(h.records.get(`${cmd.input.TableName}:${cmd.input.Key.id}`)) }) }, commit: h.commit };
});
import { relationshipOperation } from '../../amplify/functions/communications/relationships';
const actor = { sub: 'alice', groups: ['PRODUCER'] };
const save = (op: string, input: Record<string, unknown>, identity = actor) => relationshipOperation(op, { requestId: crypto.randomUUID(), ...input }, identity);
const rows = (table: string) => [...h.records].filter(([key]) => key.startsWith(`${table}:`)).map(([, v]) => v);
const seedParty = (id: string, extra: Record<string, unknown> = {}) => h.records.set(`Party:${id}`, { id, name: id, kind: 'ORGANIZATION', revision: 1, ownerId: 'alice', email: `${id}@example.com`, ...extra });
beforeEach(() => {
  h.records.clear(); h.fail = false; h.commit.mockReset();
  for (const model of ['Account', 'Contact', 'Party', 'PartyAffiliation', 'AccountRelationship', 'Activity', 'Communication']) process.env[`${model.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}_TABLE`] = model;
  h.records.set('Account:a', { id: 'a', name: 'Harbor View', stage: 'CLIENT' });
  h.records.set('Communication:workflow:a', { id: 'workflow:a', version: 1, kind: 'WORKFLOW', data: { salespersonId: 'alice', disposition: 'BOUND', name: 'Harbor View', version: 1 } });
  seedParty('apex'); seedParty('new-manager'); seedParty('jane', { kind: 'PERSON' });
  h.commit.mockImplementation(async (writes: any[]) => {
    if (h.fail) throw new Error('Storage unavailable');
    // Verify every conditional first, then apply the whole transaction.
    for (const write of writes) {
      const item = write.Put ?? write.Update ?? write.ConditionCheck;
      const id = item.Item?.id ?? item.Key?.id;
      const old = h.records.get(`${item.TableName}:${id}`), values = item.ExpressionAttributeValues ?? {};
      const condition = item.ConditionExpression ?? '';
      const bad = condition.includes('attribute_not_exists(id)') && old || condition === '#v = :v' && old?.version !== values[':v'] || condition === '#r = :r' && old?.revision !== values[':r'] || condition.includes('updatedAt = :previous') && (old?.updatedAt !== values[':previous'] || old?.accountId !== values[':account']);
      if (bad) throw Object.assign(new Error('Conflict'), { name: 'ConditionalCheckFailedException' });
    }
    for (const write of writes) {
      if (write.Put) h.records.set(`${write.Put.TableName}:${write.Put.Item.id}`, structuredClone(write.Put.Item));
      if (write.Update) { const u = write.Update, key = `${u.TableName}:${u.Key.id}`; h.records.set(key, { ...h.records.get(key), validUntil: u.ExpressionAttributeValues[':until'], updatedAt: u.ExpressionAttributeValues[':now'], lastWriteBy: u.ExpressionAttributeValues[':actor'] }); }
    }
  });
});
describe('dated representatives', () => {
  it('uses exclusive end dates and does not activate a future representative early', () => {
    expect(relationshipCurrent({ validFrom: '2026-01-01', validUntil: '2026-10-28' }, '2026-10-27')).toBe(true);
    expect(relationshipCurrent({ validUntil: '2026-10-28' }, '2026-10-28')).toBe(false);
    expect(relationshipCurrent({ validFrom: '2026-10-29' }, '2026-10-28')).toBe(false);
    expect(relationshipCurrent({}, '2026-10-28')).toBe(true);
    expect(() => relationshipDates('2026-02-30', null)).toThrow();
    expect(() => relationshipDates('2026-10-28', '2026-10-28')).toThrow();
  });
  it('excludes former contacts from primary, billing and inspection defaults', () => {
    const old = { name: 'Former manager', email: 'old@example.com', type: 'INSPECTION', isPrimary: true, isBilling: true, validUntil: '2000-01-01' };
    const current = { name: 'Current manager', email: 'new@example.com', isPrimary: true, validFrom: '2020-01-01' };
    const billing = { name: 'Accounting', email: 'billing@example.com', isBilling: true };
    expect(primaryContact([old, current, billing])).toEqual(current);
    expect(billingContact([old, current, billing])).toEqual(billing);
    expect(inspectionContact([old, current, billing])).toBeUndefined();
    expect(primaryContact([old])).toBeUndefined();
  });
});
describe('management handoff', () => {
  it('retains the insured and its original referral while replacing management and default contacts', async () => {
    const account = structuredClone(h.records.get('Account:a'));
    await save('relationshipLink', { accountId: 'a', partyId: 'apex', role: 'REFERRER', validFrom: '2024-01-01' });
    await save('relationshipChangeManagement', { accountId: 'a', partyId: 'apex', version: 0, effectiveOn: '2024-01-01', generalPartyId: 'jane', billingPartyId: 'jane' });
    const original = rows('AccountRelationship').find(r => r.role === 'MANAGER')!;
    expect(rows('Contact')).toHaveLength(1);
    await save('relationshipChangeManagement', { accountId: 'a', partyId: 'new-manager', version: 1, effectiveOn: '2026-10-28', generalPartyId: 'new-manager' });
    expect(h.records.get('Account:a')).toEqual(account);
    expect(h.records.get(`AccountRelationship:${original.id}`)?.validUntil).toBe('2026-10-28');
    expect(rows('AccountRelationship').find(r => r.role === 'REFERRER')?.partyId).toBe('apex');
    expect(rows('Contact').find(c => c.name === 'jane')?.validUntil).toBe('2026-10-28');
    expect(rows('Contact').find(c => c.name === 'new-manager')?.isPrimary).toBe(true);
    expect(h.records.get('Communication:workflow:a')?.data).toMatchObject({ salespersonId: 'alice', disposition: 'BOUND', humanTakeover: true });
    expect(rows('Activity')).toHaveLength(3);
    expect(h.commit.mock.calls.at(-1)?.[0].some((w: any) => ['Account', 'Policy', 'Invoice'].includes(w.Put?.TableName))).toBe(false);
  });
  it('retries a committed request without creating a second company or management relationship', async () => {
    const input = { accountId: 'a', partyId: 'apex', version: 0, effectiveOn: '2026-10-28', requestId: 'same-request' };
    const first = await relationshipOperation('relationshipChangeManagement', input, actor);
    expect(await relationshipOperation('relationshipChangeManagement', input, actor)).toEqual(first);
    expect(rows('AccountRelationship')).toHaveLength(1);
    expect(h.commit).toHaveBeenCalledTimes(1);
    await expect(relationshipOperation('relationshipChangeManagement', { ...input, partyId: 'new-manager' }, actor)).rejects.toThrow('request changed');
  });
  it('does not partially retire contacts when the transaction fails', async () => {
    await save('relationshipChangeManagement', { accountId: 'a', partyId: 'apex', version: 0, effectiveOn: '2024-01-01', generalPartyId: 'jane' });
    const before = structuredClone([...h.records]); h.fail = true;
    await expect(save('relationshipChangeManagement', { accountId: 'a', partyId: 'new-manager', version: 1, effectiveOn: '2026-10-28' })).rejects.toThrow('Storage unavailable');
    expect([...h.records]).toEqual(before);
  });
  it('supports a same-day correction without keeping the wrong manager active', async () => {
    await save('relationshipChangeManagement', { accountId: 'a', partyId: 'apex', version: 0, effectiveOn: '2026-10-28', generalPartyId: 'jane' });
    await save('relationshipChangeManagement', { accountId: 'a', partyId: 'new-manager', version: 1, effectiveOn: '2026-10-28', generalPartyId: 'new-manager' });
    expect(rows('AccountRelationship').filter(r => relationshipCurrent(r, '2026-10-28')).map(r => r.partyId)).toEqual(['new-manager']);
    expect(rows('Contact').filter(r => relationshipCurrent(r, '2026-10-28')).map(r => r.partyId)).toEqual(['new-manager']);
    expect(rows('AccountRelationship')).toHaveLength(2);
  });
  it('rejects stale versions, backwards transitions, and direct manager links', async () => {
    await save('relationshipChangeManagement', { accountId: 'a', partyId: 'apex', version: 0, effectiveOn: '2026-10-28' });
    await expect(save('relationshipChangeManagement', { accountId: 'a', partyId: 'new-manager', version: 0, effectiveOn: '2026-10-29' })).rejects.toThrow('Management changed');
    await expect(save('relationshipChangeManagement', { accountId: 'a', version: 1, effectiveOn: '2026-10-27' })).rejects.toThrow('latest management');
    await expect(save('relationshipLink', { accountId: 'a', partyId: 'apex', role: 'MANAGER' })).rejects.toThrow('Change management');
  });
  it('preserves the chronology when an account becomes self-managed', async () => {
    await save('relationshipChangeManagement', { accountId: 'a', partyId: 'apex', version: 0, effectiveOn: '2024-01-01' });
    await save('relationshipChangeManagement', { accountId: 'a', version: 1, effectiveOn: '2026-10-28' });
    await expect(save('relationshipChangeManagement', { accountId: 'a', partyId: 'new-manager', version: 2, effectiveOn: '2026-10-27' })).rejects.toThrow('latest management');
    expect(rows('AccountRelationship')).toHaveLength(1);
  });
  it('retires only explicitly selected legacy contacts and verifies their account', async () => {
    for (const id of ['manager', 'board']) h.records.set(`Contact:${id}`, { id, accountId: 'a', name: id, updatedAt: 'old' });
    h.records.set('Contact:foreign', { id: 'foreign', accountId: 'b', updatedAt: 'old' });
    await expect(save('relationshipChangeManagement', { accountId: 'a', partyId: 'apex', version: 0, effectiveOn: '2026-10-28', retireContactIds: ['foreign'] })).rejects.toThrow('no longer on this account');
    await save('relationshipChangeManagement', { accountId: 'a', partyId: 'apex', version: 0, effectiveOn: '2026-10-28', retireContactIds: ['manager'] });
    expect(h.records.get('Contact:manager')?.validUntil).toBe('2026-10-28');
    expect(h.records.get('Contact:board')?.validUntil).toBeUndefined();
  });
  it('never grants portfolio access to a relationship owner who does not own the insured', async () => {
    h.records.get('Communication:workflow:a')!.data.salespersonId = 'bob';
    for (const op of ['relationshipContext', 'relationshipChangeManagement', 'relationshipLink']) await expect(save(op, { accountId: 'a', partyId: 'apex', role: 'OWNER', version: 0, effectiveOn: '2026-10-28' })).rejects.toThrow('not available');
    expect(h.commit).not.toHaveBeenCalled();
  });
});
describe('shared directory', () => {
  it('creates standalone people without leads or policies and enforces profile ownership', async () => {
    const created = await save('relationshipSaveParty', { kind: 'PERSON', name: 'Independent landlord', revision: 0 });
    expect(created.party).toMatchObject({ name: 'Independent landlord', ownerId: 'alice', revision: 1 });
    expect(rows('Account')).toHaveLength(1);
    await expect(save('relationshipSaveParty', { id: 'apex', kind: 'ORGANIZATION', name: 'Changed', revision: 1 }, { sub: 'bob', groups: ['PRODUCER'] })).rejects.toThrow('relationship owner');
  });
  it('lets an administrator explicitly transfer an existing relationship to Me', async () => {
    seedParty('apex', { ownerId: 'bob' });
    const result = await save('relationshipSaveParty', { id: 'apex', kind: 'ORGANIZATION', name: 'Apex', ownerId: '', revision: 1 }, { sub: 'alice', groups: ['ADMIN'] });
    expect(result.party).toMatchObject({ ownerId: 'alice', revision: 2 });
  });
  it('does not rewrite original referrals when ending another relationship', async () => {
    const result = await save('relationshipLink', { accountId: 'a', partyId: 'apex', role: 'REFERRER' });
    await expect(save('relationshipEnd', { accountId: 'a', id: (result.relationship as any).id, revision: 1, validUntil: '2026-10-28' })).rejects.toThrow('referral attribution');
  });
  it('records dated employment without moving any insured account', async () => {
    await save('relationshipSaveAffiliation', { personId: 'jane', organizationId: 'apex', revision: 0, title: 'Property manager', validFrom: '2024-01-01', validUntil: '2026-10-28' });
    expect(rows('PartyAffiliation')[0]).toMatchObject({ personId: 'jane', organizationId: 'apex', validUntil: '2026-10-28' });
    expect(rows('AccountRelationship')).toHaveLength(0);
  });
});
