import { QueryCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authorizedQuoteTerms } from '../../../shared/quoteAuthorization';
import { packageTerms } from '../../../shared/quotePackages';
import { commissionPolicy } from './commissionFixtures';
import type { CommissionPolicy } from '../../../shared/commissions';

const h = vi.hoisted(() => ({ get: vi.fn(), getModel: vi.fn(), getFee: vi.fn(), getRow: vi.fn(),
  read: vi.fn(), commit: vi.fn(), allocate: vi.fn(), retain: vi.fn() }));
vi.mock('../../amplify/functions/commissions/ipfs-evidence', () => ({retainIpfsEvidence: h.retain}));
vi.mock('../../amplify/functions/commissions/store', () => ({ get: h.get, commit: h.commit }));
vi.mock('../../amplify/functions/commissions/ipfs-bind', async original => ({
  ...await original<typeof import('../../amplify/functions/commissions/ipfs-bind')>(), allocateIpfsAgreement: h.allocate,
}));
vi.mock('../../amplify/functions/broker-fees/store', () => ({
  db: { send: h.read }, getModel: h.getModel, getRow: h.getRow, getFee: h.getFee,
  modelTable: (model: string) => model, table: () => 'private-fee',
  versionCheck: (model: string, row: {id: string; updatedAt: string}) => ({ ConditionCheck: { TableName: model, Key: { id: row.id }, ExpressionAttributeValues: { ':v': row.updatedAt } } }),
}));
import { registerLegacyIpfsCollection } from '../../amplify/functions/commissions/ipfs-registration';

let policy: CommissionPolicy;
let models: Record<string, Record<string, unknown>>;
let billing: Record<string, Record<string, unknown>[]>;
const readHistory = async (command: QueryCommand | BatchGetCommand) => {
  if (command instanceof QueryCommand) {
    const { TableName, ExpressionAttributeNames, ExpressionAttributeValues } = command.input;
    const field = ExpressionAttributeNames!['#owner'], owner = ExpressionAttributeValues![':owner'];
    const rows = billing[TableName!].filter(row => row[field] === owner);
    return { Items: rows.map(({ id }) => ({ id })) };
  }
  if (!(command instanceof BatchGetCommand)) throw new Error('Expected a scoped query or consistent batch get.');
  const [table, read] = Object.entries(command.input.RequestItems!)[0];
  expect(read.ConsistentRead).toBe(true);
  return { Responses: { [table]: billing[table].filter(row => read.Keys!.some(key => key.id === row.id)) } };
};
afterEach(() => vi.unstubAllEnvs());
const input = { policyId: 'p', version: 1, agreementRef: 'PFA-1', amountFinancedCents: 100000, confirmed: true, documentId: 'doc' };
beforeEach(() => {
  vi.resetAllMocks();
  policy = { ...commissionPolicy(), ipfsAgreementRef: 'Existing additional compensation', ipfsFeeCents: 2000 };
  models = {
    Policy: { id: 'p', accountId: 'a', quoteId: 'q', status: 'ACTIVE', billType: 'AGENCY', updatedAt: 'old' },
    Quote: { id: 'q', accountId: 'a', status: 'BOUND', billType: 'AGENCY', updatedAt: 'old' },
    Document: { id: 'doc', entityType: 'ACCOUNT', entityId: 'a', policyId: 'p', category: 'OTHER', s3Key: 'documents/ACCOUNT/a/doc/agreement.pdf', updatedAt: 'old' },
  };
  billing = { Invoice: [], InvoiceLine: [], PfLoan: [] };
  h.get.mockImplementation(async () => policy);
  h.getModel.mockImplementation(async (model: string) => models[model]);
  vi.stubEnv('ACCESS_INDEXES', JSON.stringify({'Invoice.accountId':'account-invoice', 'PfLoan.accountId':'account-loan', 'InvoiceLine.invoiceId':'parent-invoice'}));
  h.read.mockImplementation(readHistory);
  h.retain.mockResolvedValue({key:'ipfs-evidence/retained',versionId:'signed-version',filename:'Signed IPFS agreement',sha256:'verified-hash'});
  h.allocate.mockResolvedValue({ write: { Put: { TableName: 'private-fee', Item: { id: 'agreement' } } } });
});

it('registers actual signed evidence on a clean historic term once, preserves its separate lender compensation and creates no cash', async () => {
  billing.Invoice.push({ id: 'other', accountId: 'a', policyId: 'other', status: 'PAID' });
  await registerLegacyIpfsCollection(input, 'owner');
  expect(h.read.mock.calls.filter(([command]) => command instanceof QueryCommand).map(([command]) => [command.input.IndexName, command.input.ExpressionAttributeValues[':owner']])).toEqual(expect.arrayContaining([['account-invoice', 'a'], ['account-loan','a'], ['parent-invoice','other']]));
  expect(h.read.mock.calls.some(([command]) => command instanceof BatchGetCommand)).toBe(true);
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
  const quoteUpdate = extras.find((item: {Update?: {TableName: string}}) => item.Update?.TableName === 'Quote')!.Update;
  expect(quoteUpdate.UpdateExpression).toBe('SET ipfsRegisteredPolicyId = :policy, updatedAt = :now, lastWriteBy = :actor');
  for (const field of ['#status', 'accountId', 'updatedAt', 'sourcePricingInvoiceId', 'sourcePricingLoanId', 'ipfsRegisteredPolicyId'])
    expect(quoteUpdate.ConditionExpression).toContain(field);
  expect(changes[0].value.ipfsLegacyEvidence).toMatchObject({ versionId:'signed-version',sha256:'verified-hash' });
  const original = { ...models.Quote, id:'q', accountId:'a', status:'BOUND', lines:['D&O'], commissionPct:12, premium:1000 };
  const marked = { ...original, ipfsRegisteredPolicyId:'p' };
  expect(authorizedQuoteTerms(marked)).toBe(authorizedQuoteTerms(original));
  expect(packageTerms(marked)).toBe(packageTerms(original));
  policy = { ...changes[0].value, version: 2 };
  models.Quote.ipfsRegisteredPolicyId = 'p';
  Object.assign(models.Policy, {ipfsAmountFinanced:1000,ipfsAgreementRef:'PFA-1'});
  delete models.Document;
  await registerLegacyIpfsCollection(input, 'owner');
  expect(h.commit).toHaveBeenCalledTimes(1);
  await expect(registerLegacyIpfsCollection({ ...input, amountFinancedCents: 100001 }, 'owner')).rejects.toThrow(/already/);
});

it.each(['signed fee','paid invoice','draft invoice','line-only invoice','unanchored invoice','group loan','fee receipt','cash marker','mismatched document','archive failed','unconfirmed','account changed','incomplete lookup'])('refuses registration for %s without changing any history', async condition => {
  if (condition === 'signed fee') h.getFee.mockResolvedValue({ amountCents: 1000, signedAt: 'old' });
  if (condition === 'paid invoice') billing.Invoice.push({ id: 'i', accountId: 'a', policyId: 'p', status: 'PAID' });
  if (condition === 'draft invoice') billing.Invoice.push({ id: 'i', accountId: 'a', quoteId: 'q', status: 'DRAFT' });
  if (condition === 'line-only invoice') { billing.Invoice.push({ id: 'i', accountId: 'a', policyId: 'other', status: 'SENT' }); billing.InvoiceLine.push({ id: 'line', invoiceId: 'i', policyId: 'p' }); }
  if (condition === 'unanchored invoice') billing.Invoice.push({ id: 'i', accountId: 'a', status: 'SENT' });
  if (condition === 'group loan') billing.PfLoan.push({ id: 'l', accountId: 'a', groupedPolicyIds: ['p'], status: 'ACTIVE' });
  if (condition === 'fee receipt') models.Policy.brokerFeeCollected = 24;
  if (condition === 'cash marker') h.getRow.mockResolvedValue({ id: 'hoa-collection-policy:p' });
  if (condition === 'archive failed') h.retain.mockRejectedValue(new Error('The retained version is unavailable.'));
  if (condition === 'mismatched document') models.Document.policyId = 'other';
  if (condition === 'account changed') models.Quote.accountId = 'other';
  if (condition === 'incomplete lookup') h.read.mockRejectedValue(new Error('Unavailable'));
  await expect(registerLegacyIpfsCollection({ ...input, confirmed: condition !== 'unconfirmed' }, 'owner')).rejects.toThrow();
  expect(h.commit).not.toHaveBeenCalled();
});


it('follows an empty index page and rechecks current line-only history from the account invoice', async () => {
  billing.Invoice.push({ id: 'old', accountId: 'a', policyId: 'other', status: 'SENT' });
  billing.InvoiceLine.push({ id: 'old-line', invoiceId: 'old', brokerFeeQuoteId: 'q' });
  h.read.mockImplementation(async (command: QueryCommand | BatchGetCommand) => {
    if (command instanceof QueryCommand && command.input.TableName === 'InvoiceLine' && !command.input.ExclusiveStartKey) {
      return { Items: [], LastEvaluatedKey: { id: 'earlier' } };
    }
    return readHistory(command);
  });
  await expect(registerLegacyIpfsCollection(input, 'owner')).rejects.toThrow(/invoice/);
  expect(h.commit).not.toHaveBeenCalled();
  expect(h.read.mock.calls.some(([command]) => command instanceof QueryCommand && command.input.ExclusiveStartKey?.id === 'earlier')).toBe(true);
});

it('uses current scope and billing status when an index key points to a moved or updated record', async () => {
  billing.Invoice.push({ id: 'moved', accountId: 'other', policyId: 'p', status: 'PAID' }, { id: 'current', accountId: 'a', policyId: 'p', status: 'PAID' });
  h.read.mockImplementation(async (command: QueryCommand | BatchGetCommand) => {
    if (command instanceof QueryCommand && command.input.TableName === 'Invoice') {
      return { Items: [{ id: 'moved', accountId: 'a', status: 'PAID' }, { id: 'current', accountId: 'a', status: 'VOID' }] };
    }
    return readHistory(command);
  });
  await expect(registerLegacyIpfsCollection(input, 'owner')).rejects.toThrow(/invoice/);
  billing.Invoice.pop();
  await registerLegacyIpfsCollection(input, 'owner');
  expect(h.commit).toHaveBeenCalledTimes(1);
});

it('checks only this account when the agency has over 25,000 records elsewhere', async () => {
  billing.Invoice = Array.from({ length: 25001 }, (_, i) => ({ id: `other-${i}`, accountId: 'elsewhere', policyId: 'elsewhere' }));
  await registerLegacyIpfsCollection(input, 'owner');
  expect(h.read).toHaveBeenCalledTimes(2);
  expect(h.read.mock.calls.every(([command]) => command instanceof QueryCommand && command.input.ExpressionAttributeValues?.[':owner'] === 'a')).toBe(true);
});
