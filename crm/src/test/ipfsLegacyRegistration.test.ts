import { beforeEach, expect, it, vi } from 'vitest';
import { commissionPolicy } from './commissionFixtures';
import type { CommissionPolicy } from '../../../shared/commissions';

const h = vi.hoisted(() => ({ get: vi.fn(), getModel: vi.fn(), getFee: vi.fn(), getRow: vi.fn(),
  scan: vi.fn(), commit: vi.fn(), allocate: vi.fn() }));
vi.mock('../../amplify/functions/commissions/store', () => ({ get: h.get, commit: h.commit }));
vi.mock('../../amplify/functions/commissions/ipfs-bind', async original => ({
  ...await original<typeof import('../../amplify/functions/commissions/ipfs-bind')>(), allocateIpfsAgreement: h.allocate,
}));
vi.mock('../../amplify/functions/broker-fees/store', () => ({
  db: { send: h.scan }, getModel: h.getModel, getRow: h.getRow, getFee: h.getFee,
  modelTable: (model: string) => model, table: () => 'private-fee',
  versionCheck: (model: string, row: {id: string; updatedAt: string}) => ({ ConditionCheck: { TableName: model, Key: { id: row.id }, ExpressionAttributeValues: { ':v': row.updatedAt } } }),
}));
import { registerLegacyIpfsCollection } from '../../amplify/functions/commissions/ipfs-registration';

let policy: CommissionPolicy;
let models: Record<string, Record<string, unknown>>;
let scans: Record<string, Record<string, unknown>[]>;
const input = { policyId: 'p', version: 1, agreementRef: 'PFA-1', amountFinancedCents: 100000, confirmed: true, documentId: 'doc' };
beforeEach(() => {
  vi.resetAllMocks();
  policy = { ...commissionPolicy(), ipfsAgreementRef: 'Existing additional compensation', ipfsFeeCents: 2000 };
  models = {
    Policy: { id: 'p', accountId: 'a', quoteId: 'q', status: 'ACTIVE', billType: 'AGENCY', updatedAt: 'old' },
    Quote: { id: 'q', accountId: 'a', status: 'BOUND', billType: 'AGENCY', updatedAt: 'old' },
    Document: { id: 'doc', entityType: 'ACCOUNT', entityId: 'a', policyId: 'p', category: 'OTHER', s3Key: 'documents/ACCOUNT/a/doc/agreement.pdf', updatedAt: 'old' },
  };
  scans = { Invoice: [], InvoiceLine: [], PfLoan: [] };
  h.get.mockImplementation(async () => policy);
  h.getModel.mockImplementation(async (model: string) => models[model]);
  h.scan.mockImplementation(async ({input: { TableName }}: { input: { TableName: string } }) => ({ Items: scans[TableName] }));
  h.allocate.mockResolvedValue({ write: { Put: { TableName: 'private-fee', Item: { id: 'agreement' } } } });
});

it('registers actual signed evidence on a clean historic term once, preserves its separate lender compensation and creates no cash', async () => {
  scans.Invoice.push({ id: 'other', accountId: 'a', policyId: 'other', status: 'PAID' });
  await registerLegacyIpfsCollection(input, 'owner');
  expect(h.scan.mock.calls.every(([command]) => command.input.ConsistentRead)).toBe(true);
  const [changes, actor, extras] = h.commit.mock.calls[0];
  expect(actor).toBe('owner');
  expect(changes).toHaveLength(1);
  expect(changes[0].value).toMatchObject({
    entries: [], ipfsAgreementRef: 'Existing additional compensation', ipfsFeeCents: 2000, ipfsCollectionRef: 'PFA-1',
    ipfsLegacyDocumentId: 'doc', ipfsAmountFinancedCents: 100000, ipfsConfirmedBy: 'owner',
  });
  expect(extras).toEqual(expect.arrayContaining([
    { ConditionCheck: { TableName: 'private-fee', Key: { id: 'hoa-collection-policy:p' }, ConditionExpression: 'attribute_not_exists(id)' } },
    { ConditionCheck: { TableName: 'private-fee', Key: { id: 'fee:q' }, ConditionExpression: 'attribute_not_exists(id)' } },
    expect.objectContaining({ Update: expect.objectContaining({ TableName: 'Policy', ExpressionAttributeValues: expect.objectContaining({ ':ref': 'PFA-1', ':amount': 1000 }) }) }),
  ]));
  expect(extras.some((item: {Update?: {TableName: string}}) => item.Update?.TableName === 'Quote')).toBe(false);
  policy = { ...changes[0].value, version: 2 };
  await registerLegacyIpfsCollection(input, 'owner');
  expect(h.commit).toHaveBeenCalledTimes(1);
  await expect(registerLegacyIpfsCollection({ ...input, amountFinancedCents: 100001 }, 'owner')).rejects.toThrow(/already/);
});

it.each(['signed fee','paid invoice','draft invoice','line-only invoice','unanchored invoice','group loan','fee receipt','cash marker','mismatched document','unconfirmed','account changed','incomplete lookup'])('refuses registration for %s without changing any history', async condition => {
  if (condition === 'signed fee') h.getFee.mockResolvedValue({ amountCents: 1000, signedAt: 'old' });
  if (condition === 'paid invoice') scans.Invoice.push({ id: 'i', policyId: 'p', status: 'PAID' });
  if (condition === 'draft invoice') scans.Invoice.push({ id: 'i', quoteId: 'q', status: 'DRAFT' });
  if (condition === 'line-only invoice') { scans.Invoice.push({ id: 'i', policyId: 'other', status: 'SENT' }); scans.InvoiceLine.push({ invoiceId: 'i' }); }
  if (condition === 'unanchored invoice') scans.Invoice.push({ id: 'i', status: 'SENT' });
  if (condition === 'group loan') scans.PfLoan.push({ id: 'l', groupedPolicyIds: ['p'], status: 'ACTIVE' });
  if (condition === 'fee receipt') models.Policy.brokerFeeCollected = 24;
  if (condition === 'cash marker') h.getRow.mockResolvedValue({ id: 'hoa-collection-policy:p' });
  if (condition === 'mismatched document') models.Document.policyId = 'other';
  if (condition === 'account changed') models.Quote.accountId = 'other';
  if (condition === 'incomplete lookup') h.scan.mockRejectedValue(new Error('Unavailable'));
  await expect(registerLegacyIpfsCollection({ ...input, confirmed: condition !== 'unconfirmed' }, 'owner')).rejects.toThrow();
  expect(h.commit).not.toHaveBeenCalled();
});
