import { expect, it } from 'vitest';
import { AccountAccess } from '../../amplify/functions/crm-access/access';
import type { RecordData } from '../../amplify/functions/crm-access/policy';
function access(role: string) {
  const records: Record<string, RecordData> = {
    'Policy:p': {
      id: 'p',
      accountId: 'a',
      quoteId: 'q',
      premium: 10000,
      commissionPct: 12,
      commissionSnapshotId: 'p',
    },
    'Policy:legacy': { id: 'legacy', accountId: 'a' },
    'Quote:q': { id: 'q', accountId: 'a', status: 'QUOTED' },
    'Quote:bound': { id: 'bound', accountId: 'a', status: 'BOUND' },
    'Communication:workflow:a': { data: { salespersonId: 'producer' } },
  };
  return new AccountAccess(
    { sub: 'producer', groups: [role] },
    async (model, id) => records[`${model}:${id}`],
    { headers: { 'x-crm-role': role } },
  );
}
it.each(['OWNER', 'ADMIN', 'PRODUCER', 'STAFF'])(
  'prevents %s from bypassing financial bind capture',
  async (role) => {
    const a = access(role);
    await expect(a.write('Policy', 'create', { id: 'new', accountId: 'a' })).rejects.toThrow(
      /bind workflow/,
    );
    await expect(a.write('Quote', 'update', { id: 'q', status: 'BOUND' })).rejects.toThrow(
      /bind workflow/,
    );
    await expect(a.write('Policy', 'update', { id: 'p', premium: 20000 })).rejects.toThrow(
      /immutable/,
    );
    await expect(
      a.write('Policy', 'update', { id: 'p', commissionSnapshotId: null }),
    ).rejects.toThrow(/server-owned/);
  },
);
it.each(['OWNER', 'PRODUCER'])(
  'allows %s to save unchanged financial values with servicing edits',
  async (role) => {
    await expect(
      access(role).write('Policy', 'update', {
        id: 'p',
        premium: 10000,
        commissionPct: 12,
        notes: 'Service note',
      }),
    ).resolves.toBeUndefined();
    await expect(
      access(role).write('Quote', 'update', {
        id: 'bound',
        status: 'BOUND',
        notes: 'Service note',
      }),
    ).resolves.toBeUndefined();
  },
);

it.each(['OWNER', 'PRODUCER'])(
  'allows %s to save historical notes with unchanged nullish fields',
  async (role) => {
    const a = access(role);
    await expect(
      a.write('Policy', 'update', {
        id: 'legacy',
        notes: 'Service note',
        premium: null,
        commissionPct: null,
        carrierId: null,
        effectiveDate: null,
        expirationDate: null,
      }),
    ).resolves.toBeUndefined();
    await expect(a.write('Policy', 'update', { id: 'legacy', commissionPct: 12 })).rejects.toThrow(
      /immutable/,
    );
    await expect(a.write('Policy', 'update', { id: 'p', commissionPct: null })).rejects.toThrow(
      /immutable/,
    );
  },
);
it.each(['OWNER', 'ADMIN', 'PRODUCER', 'STAFF'])(
  'prevents %s from desynchronizing a tracked policy number',
  async (role) => {
    await expect(
      access(role).write('Policy', 'update', { id: 'p', policyNumber: 'NEW-1' }),
    ).rejects.toThrow(/Commissions/);
  },
);
it('allows legacy policy number entry before commission adoption', async () => {
  await expect(
    access('OWNER').write('Policy', 'update', { id: 'legacy', policyNumber: 'OLD-1' }),
  ).resolves.toBeUndefined();
});
