import { randomUUID } from 'node:crypto';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { db, modelTable, type Write } from '../broker-fees/store';
import { object } from '../api-input';
import type { AccountAccess } from './access';
import { AccessDenied, id, type RecordData as Row } from './policy';
import { activeTeamUserCheck } from './user-status';

const LINE_FIELDS = new Set([
  'id', 'invoiceId', 'accountId', 'policyId', 'description', 'brokerFeeQuoteId',
  'sourceQuoteChargeId', 'kind', 'retailAmount', 'costAmount', 'sortOrder', 'updatedBy',
]);
const DELIVERY_FIELDS = [
  'invoiceSendOperation', 'supersededByGroupedInvoiceId', 'sentAt', 'paidAt', 'paymentUrl',
  'stripePaymentLinkId', 'stripePaymentIntentId', 'stripeLinkAmountCents', 'brokerFeeAllocations', 'brokerFeeFinanceUrl',
];
const isPolicySource = (row: Row | undefined): row is Row => row?.sourcePricingVersion === 1 && !!id(row.policyId);
const retry = 'The invoice or its lines changed. Refresh the draft and try again.';

type NativeLineContext = {
  model?: string; field?: string; arguments?: Row; nativeConditions?: unknown; nativeAuthFilter?: unknown;
};

/** The native authorization stages have run. The following AppSync stage
 * returns this committed line and skips its duplicate Dynamo operation. */
export async function writeInvoiceDraftLine(access: AccountAccess, context: NativeLineContext): Promise<
  { handled: false } | { handled: true; line: Row }
> {
  const operation = /^(create|update|delete)InvoiceLine$/.exec(context.field ?? '')?.[1];
  if (context.model !== 'InvoiceLine' || !operation) throw new AccessDenied();
  const args = object(context.arguments), input = object(args.input);
  // Preserve the standard assignment and financial checks for native
  // passthrough writes as well as writes we commit here.
  await access.write('InvoiceLine', operation, input);
  const previous = input.id ? await access.get('InvoiceLine', id(input.id)) : undefined;
  const candidate = { ...previous, ...input };
  const invoice = await access.get('Invoice', id(candidate.invoiceId));
  const original = previous?.invoiceId && previous.invoiceId !== candidate.invoiceId
    ? await access.get('Invoice', id(previous.invoiceId)) : invoice;
  if (!isPolicySource(invoice) && !isPolicySource(original)) return { handled: false };

  if (previous && previous.invoiceId !== candidate.invoiceId &&
      (invoice?.status === 'DRAFT' && isPolicySource(invoice) || original?.status === 'DRAFT' && isPolicySource(original))) {
    throw new Error('A source-priced draft line must stay on its original invoice.');
  }
  if (!isPolicySource(invoice) || invoice.status !== 'DRAFT') return { handled: false };
  if (DELIVERY_FIELDS.some(key => invoice[key] != null && invoice[key] !== '')) {
    throw new Error('Finish or review the existing invoice operation before editing its lines.');
  }
  if (Object.keys(input).some(key => operation === 'delete' ? key !== 'id' : !LINE_FIELDS.has(key)) ||
      Object.keys(args).some(key => !['input', 'condition'].includes(key)) || args.condition != null ||
      (Array.isArray(context.nativeConditions) ? context.nativeConditions.length > 0 : context.nativeConditions != null) ||
      Object.keys(object(context.nativeAuthFilter)).length > 0) {
    throw new Error('Conditional or unsupported source-priced draft line changes cannot be saved. Refresh the draft and try again.');
  }

  const invoiceId = id(invoice.id), accountId = id(invoice.accountId), policyId = id(invoice.policyId);
  const lineId = id(input.id) || (operation === 'create' && input.id == null ? randomUUID() : '');
  if (!invoiceId || !accountId || !policyId || !lineId || (operation !== 'create' && !previous)) throw new Error(retry);
  if (operation !== 'delete') {
    for (const [field, expected] of [['accountId', accountId], ['policyId', policyId]]) {
      if (candidate[field] != null && candidate[field] !== expected ||
          previous?.[field] != null && previous[field] !== candidate[field]) {
        throw new Error('A source-priced draft line must keep its original account and policy.');
      }
    }
  }
  const invoiceVersion = Date.parse(String(invoice.updatedAt));
  const lineVersion = previous ? Date.parse(String(previous.updatedAt)) : 0;
  if (!Number.isFinite(invoiceVersion) || !Number.isFinite(lineVersion)) throw new Error(retry);
  const now = new Date(Math.max(Date.now(), invoiceVersion + 1, lineVersion + 1)).toISOString();

  const writes: Write[] = [activeTeamUserCheck(access.actor), { ConditionCheck: {
    TableName: modelTable('Communication'), Key: { id: `deleted-account:${accountId}` },
    ConditionExpression: 'attribute_not_exists(id)',
  } }];
  if (!access.admin) {
    const workflow = await access.get('Communication', `workflow:${accountId}`);
    if (!workflow || object(workflow.data).salespersonId !== access.actor) throw new AccessDenied();
    writes.push({ ConditionCheck: {
      TableName: modelTable('Communication'), Key: { id: `workflow:${accountId}` },
      ConditionExpression: '#data = :data', ExpressionAttributeNames: { '#data': 'data' },
      ExpressionAttributeValues: { ':data': workflow.data },
    } });
  }

  const names: Record<string, string> = { '#status': 'status', '#revision': 'draftLineRevision', '#ids': 'draftLineIds' };
  const values: Row = {
    ':draft': 'DRAFT', ':source': 1, ':account': accountId, ':policy': policyId, ':old': invoice.updatedAt,
    ':now': now, ':one': 1, ':member': new Set([lineId]),
  };
  const conditions = ['#status = :draft', 'sourcePricingVersion = :source', 'accountId = :account', 'policyId = :policy', 'updatedAt = :old'];
  for (const [index, field] of DELIVERY_FIELDS.entries()) {
    const name = `#delivery${index}`, value = `:delivery${index}`;
    names[name] = field;
    if (!Object.hasOwn(invoice, field)) conditions.push(`attribute_not_exists(${name})`);
    else { conditions.push(`${name} = ${value}`); values[value] = invoice[field]; }
  }
  const membership = operation === 'delete' ? ' DELETE #ids :member' : ', #ids :member';
  writes.push({ Update: {
    TableName: modelTable('Invoice'), Key: { id: invoiceId },
    ConditionExpression: conditions.join(' AND '),
    UpdateExpression: `SET updatedAt = :now ADD #revision :one${membership}`,
    ExpressionAttributeNames: names, ExpressionAttributeValues: values,
  } });

  const line: Row = previous ? { ...previous } : {
    id: lineId, __typename: 'InvoiceLine', invoiceId, accountId, policyId, createdAt: now,
  };
  const lineTable = modelTable('InvoiceLine');
  if (operation === 'create') {
    for (const [field, value] of Object.entries(input)) if (field !== 'id' && value != null) line[field] = value;
    line.updatedAt = now;
    writes.push({ Put: { TableName: lineTable, Item: line, ConditionExpression: 'attribute_not_exists(id)' } });
  } else {
    const guard = {
      TableName: lineTable, Key: { id: lineId }, ConditionExpression: 'updatedAt = :old AND invoiceId = :invoice',
      ExpressionAttributeValues: { ':old': previous!.updatedAt, ':invoice': invoiceId } as Row,
    };
    if (operation === 'delete') writes.push({ Delete: guard });
    else {
      const set = ['updatedAt = :now'], remove: string[] = [], fields: Record<string, string> = {};
      guard.ExpressionAttributeValues[':now'] = now;
      for (const [index, [field, value]] of Object.entries(input).entries()) {
        if (field === 'id') continue;
        const name = `#field${index}`, token = `:value${index}`;
        fields[name] = field;
        if (value == null) { delete line[field]; remove.push(name); }
        else { line[field] = value; set.push(`${name} = ${token}`); guard.ExpressionAttributeValues[token] = value; }
      }
      line.updatedAt = now;
      writes.push({ Update: { ...guard,
        UpdateExpression: `SET ${set.join(', ')}${remove.length ? ` REMOVE ${remove.join(', ')}` : ''}`,
        ...(Object.keys(fields).length ? { ExpressionAttributeNames: fields } : {}),
      } });
    }
  }
  // The native pipeline already notifies clients after this commit succeeds.
  try { await db.send(new TransactWriteCommand({ TransactItems: writes })); }
  catch (error) {
    if ((error as { name?: string }).name === 'TransactionCanceledException') throw new Error(retry);
    throw error;
  }
  return { handled: true, line };
}
