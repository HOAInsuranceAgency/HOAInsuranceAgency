import { usesIpfs } from '../../../shared/ipfsCollection';
import { getModel, modelTable, table, versionCheck, type Write } from './broker-fees/store';

export class IpfsInvoiceBlocked extends Error {}

export function assertHoaCollection(source: { ipfsAmountFinanced?: unknown; ipfsRegisteredPolicyId?: unknown; clientBillingSelected?: unknown; billType?: unknown } | null | undefined) {
  if (source?.clientBillingSelected === true && source.billType === 'DIRECT')
    throw new IpfsInvoiceBlocked('The carrier bills this client directly. Skip the HOA invoice.');
  if (usesIpfs(source) || source?.ipfsRegisteredPolicyId != null) throw new IpfsInvoiceBlocked('IPFS collects from the client. Do not create or collect an HOA invoice for this term.');
}

export function hoaQuoteCollectionGuard(quote: { id:string; accountId?:unknown; updatedAt?:unknown }) {
  const version = versionCheck(modelTable('Quote'),quote).ConditionCheck!;
  return { ConditionCheck: { ...version,
    ConditionExpression: version.ConditionExpression + ' AND accountId = :account AND (attribute_not_exists(ipfsAmountFinanced) OR ipfsAmountFinanced = :nil) AND (attribute_not_exists(ipfsRegisteredPolicyId) OR ipfsRegisteredPolicyId = :nil) AND NOT (#status = :bound) AND NOT (clientBillingSelected = :yes AND billType = :direct)',
    ExpressionAttributeNames: { ...version.ExpressionAttributeNames, '#status':'status' },
    ExpressionAttributeValues: { ...version.ExpressionAttributeValues, ':account':quote.accountId, ':nil':null, ':bound':'BOUND', ':yes':true, ':direct':'DIRECT' },
  } };
}

/** Reserve every invoiced policy, including historical line-only terms. The
 * inverse check when an Owner registers old IPFS coverage prevents both paths
 * from winning concurrently, even when the invoice index has not caught up. */
export async function policyCollectionWrites(accountId: string, invoiceId: string, policyIds: string[], checkedPolicyId?: string | null) {
  const ids = [...new Set(policyIds.filter(Boolean))];
  const writes: Write[] = [];
  for (const id of ids) {
    if (id !== checkedPolicyId) {
      const policy = await getModel('Policy', id);
      if (!policy || policy.accountId !== accountId) throw new IpfsInvoiceBlocked('The billing source for an invoice line could not be verified.');
      assertHoaCollection(policy);
    }
    writes.push({ ConditionCheck: { TableName:modelTable('Policy'), Key:{id},
      ConditionExpression:'accountId = :account AND (attribute_not_exists(ipfsAmountFinanced) OR ipfsAmountFinanced = :nil) AND NOT (clientBillingSelected = :yes AND billType = :direct)',
      ExpressionAttributeValues:{':account':accountId,':nil':null,':yes':true,':direct':'DIRECT'} } });
    writes.push({ Update: { TableName:table(), Key:{id:'hoa-collection-policy:' + id},
      UpdateExpression:'SET accountId = :account, invoiceId = :invoice, #kind = :kind ADD #version :one',
      ExpressionAttributeNames:{'#kind':'kind','#version':'version'},
      ExpressionAttributeValues:{':account':accountId,':invoice':invoiceId,':kind':'HOA_COLLECTION_POLICY',':one':1} } });
  }
  return writes;
}
