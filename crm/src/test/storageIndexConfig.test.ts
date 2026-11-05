// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_MODELS } from '../../amplify/functions/crm-access/policy';
import { INVOICE_INDEX_KEYS, isIndexedAccountModel, modelIndexFields, modelIndexKey, requireModelIndexKey, type ModelIndexMap } from '../../amplify/functions/storage/model-indexes';
import { parseAccessIndexes, resolveAccessIndex } from '../../amplify/functions/storage/index-config';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@aws-sdk/lib-dynamodb', async original => ({ ...await original<object>(), DynamoDBDocumentClient: { from: () => ({ send }) } }));
import { accountModels } from '../../amplify/functions/broker-fees/store';

const error = () => new Error('caller configuration error');
const invoice = modelIndexKey('Invoice', 'accountId');
const lines = modelIndexKey('InvoiceLine', 'invoiceId');
const parse = (value: unknown) => parseAccessIndexes(JSON.stringify(value), error);
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
beforeEach(() => { send.mockReset(); vi.stubEnv('ACCESS_TABLES', '{}'); vi.stubEnv('ACCESS_API_ID', 'retained-api'); });

// These examples are compiled by both app/backend TypeScript checks. A string
// assertion or a generic that infers a wider model would silently lose this guard.
if (false) {
  // @ts-expect-error Invoice is indexed by accountId, not invoiceId.
  modelIndexKey('Invoice', 'invoiceId');
  // @ts-expect-error InvoiceLine uses its authoritative invoice parent.
  modelIndexKey('InvoiceLine', 'accountId');
  // @ts-expect-error Private communication indexes do not belong in ACCESS_INDEXES.
  modelIndexKey('Communication', 'assignment');
  // @ts-expect-error An undeclared flat key cannot enter the producer's typed map.
  const invalid: ModelIndexMap = { 'Invoice.invoiceId': 'wrong-index' };
  void invalid;
  // @ts-expect-error Account-model discovery cannot query invoice lines by a nonexistent account index.
  void accountModels('InvoiceLine', 'account');
}

describe('generated model-index declarations', () => {
  it('keeps the complete existing field set and the two-key invoice environment projection', () => {
    const keys = ACCOUNT_MODELS.filter(isIndexedAccountModel).flatMap(model => modelIndexFields(model).map(field => modelIndexKey(model, field)));
    expect(keys).toEqual([
      'AccountRelationship.accountId', 'Contact.accountId', 'PriorCarrier.accountId', 'Activity.entityId',
      'Loss.accountId', 'Blanket.accountId', 'GlClassCode.accountId', 'DoCoveragePart.accountId', 'Building.accountId',
      'Quote.accountId', 'Policy.accountId', 'Invoice.accountId', 'InvoiceLine.invoiceId', 'PfComplianceLog.accountId',
      'PfLoan.accountId', 'PfLoanPayment.loanId', 'PfNotice.loanId', 'PfOverride.policyId', 'Document.entityId',
      'Document.entityType', 'MarketingTask.accountId', 'Certificate.accountId', 'LeadReply.accountId',
      'UploadPortal.accountId', 'HoneycombEstimate.accountId', 'HoneycombSubmission.accountId',
    ]);
    expect(INVOICE_INDEX_KEYS).toEqual(['Invoice.accountId', 'InvoiceLine.invoiceId']);
    const deployed = Object.fromEntries(keys.map(key => [key, `retained_${key.replace('.', '_')}`])) as ModelIndexMap;
    expect(Object.fromEntries(INVOICE_INDEX_KEYS.map(key => [key, deployed[key]]))).toEqual({
      'Invoice.accountId': 'retained_Invoice_accountId', 'InvoiceLine.invoiceId': 'retained_InvoiceLine_invoiceId',
    });
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('validates dynamic model/field pairs without admitting private, natural-key or shared indexes', () => {
    expect(requireModelIndexKey('InvoiceLine', 'invoiceId', error)).toBe(lines);
    for (const [model, field] of [['InvoiceLine', 'accountId'], ['Account', 'accountId'], ['GlApplication', 'accountId'], ['Carrier', 'accountId'], ['Communication', 'assignment']]) {
      expect(() => requireModelIndexKey(model, field, error)).toThrow('caller configuration error');
    }
  });
});

describe('caller-scoped index configuration', () => {
  it('reads canonical flat keys and ignores unrelated configuration entries', () => {
    expect(resolveAccessIndex(parse({ [invoice]: 'physical-retained-account', [lines]: 'physical-retained-lines', unrelated: false }), invoice, { error })).toBe('physical-retained-account');
    expect(resolveAccessIndex(parse({ [lines]: 'physical-retained-lines' }), lines, { error })).toBe('physical-retained-lines');
  });

  it('keeps nested/model-string support opt-in with canonical flat precedence', () => {
    for (const value of [{ Invoice: { accountId: 'nested' } }, { Invoice: 'nested' }, { [invoice]: { accountId: 'nested' } }]) {
      expect(resolveAccessIndex(parse(value), invoice, { nested: true, error })).toBe('nested');
      expect(() => resolveAccessIndex(parse(value), invoice, { error })).toThrow('caller configuration error');
    }
    expect(resolveAccessIndex(parse({ [invoice]: 'flat', Invoice: { accountId: 'nested' } }), invoice, { nested: true, error })).toBe('flat');
    expect(resolveAccessIndex(parse({ [invoice]: null, Invoice: { accountId: 'nested' } }), invoice, { nested: true, error })).toBe('nested');
  });

  it('keeps the broker-fee fallback explicit, including an empty flat entry overriding nested data', () => {
    const options = { nested: true, fallback: 'crmBy_accountId', error };
    expect(resolveAccessIndex(parseAccessIndexes(undefined, error), invoice, options)).toBe('crmBy_accountId');
    expect(resolveAccessIndex(parse({ [invoice]: '', Invoice: { accountId: 'nested' } }), invoice, options)).toBe('crmBy_accountId');
    expect(() => resolveAccessIndex(parse({}), invoice, { error })).toThrow('caller configuration error');
  });

  it.each(['{', 'null', '[]', '"index"', '5', 'false'])('rejects invalid root %s with the caller error', raw => {
    expect(() => parseAccessIndexes(raw, error)).toThrow('caller configuration error');
  });

  it.each([15, true, false, [], ['index'], { unexpected: 'index' }])('rejects an invalid selected index before an SDK request: %s', value => {
    expect(() => resolveAccessIndex(parse({ [lines]: value }), lines, { error })).toThrow('caller configuration error');
  });

  it('retains each strict caller missing-index message', () => {
    for (const message of ['Original invoice line access is not configured.', 'Invoice line access is not configured.', 'Missing list index for InvoiceLine.invoiceId']) {
      expect(() => resolveAccessIndex(parse({}), lines, { error: () => new Error(message) })).toThrow(message);
    }
  });
});

describe('broker-fee account discovery configuration integration', () => {
  it.each([
    [{ 'Invoice.accountId': 'flat-account' }, 'flat-account'],
    [{ Invoice: { accountId: 'nested-account' } }, 'nested-account'],
    [{ Invoice: 'model-account' }, 'model-account'],
    [{}, 'crmBy_accountId'],
  ])('preserves configured index and complete discovery across an empty GSI page: %s', async (config, expected) => {
    vi.stubEnv('ACCESS_INDEXES', JSON.stringify(config));
    send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { id: 'empty-page' } }).mockResolvedValueOnce({ Items: [{ id: 'invoice', accountId: 'account' }] });
    expect(await accountModels('Invoice', 'account')).toEqual([{ id: 'invoice', accountId: 'account' }]);
    expect(send).toHaveBeenCalledTimes(2);
    for (const [command] of send.mock.calls) {
      expect(command.input).toMatchObject({ TableName: 'Invoice-retained-api-NONE', IndexName: expected, KeyConditionExpression: 'accountId = :account', ExpressionAttributeValues: { ':account': 'account' } });
      expect(command.input.ConsistentRead).toBeUndefined(); // GSI discovery remains eventual; consumers reread current sources.
      expect(command.input.Limit).toBeUndefined();
    }
    expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({ id: 'empty-page' });
  });

  it.each(['{', 'null', '[]', '{"Invoice.accountId":15}'])('makes no database request for invalid configuration %s', async config => {
    vi.stubEnv('ACCESS_INDEXES', config);
    await expect(accountModels('Invoice', 'account')).rejects.toThrow('Broker fee account storage is not configured.');
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps the 100-page complete-read budget rather than returning partial invoice history', async () => {
    vi.stubEnv('ACCESS_INDEXES', '{}');
    send.mockImplementation(async () => ({ Items: [], LastEvaluatedKey: { id: `page-${send.mock.calls.length}` } }));
    await expect(accountModels('Invoice', 'account')).rejects.toThrow('The account payment list could not be loaded completely.');
    expect(send).toHaveBeenCalledTimes(100);
  });
});
