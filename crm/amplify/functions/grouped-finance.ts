import { agencyDay } from '../../../shared/agencyTime';
import { financeableInvoiceTotal, formatMoney, invoiceTotals } from '../../../shared/invoiceTotals';
import { normalizePassThroughCharges } from '../../../shared/passThroughCharges';
import { isRealIsoDay } from '../../../shared/premiumFinance/noticeSequence';
import type { Schema } from '../data/resource';
import { db, getModel, modelTable, versionCheck } from './broker-fees/store';
import type { LambdaDataClient } from './data-client';
import { batchGetComplete } from './storage/batchGet';
import { validateInvoiceSourceCharges } from './send-invoice/passThroughInvoice';

type Stored<K extends 'Invoice' | 'InvoiceLine' | 'Account' | 'Policy' | 'Carrier'> =
  Schema[K]['type'] & Record<string, unknown>;
const MAX_LINES = 38;
const problem = () => new Error('The combined invoice no longer matches its reviewed policies and amounts. Review the draft before billing.');
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const hasPayment = (row: Stored<'Invoice'>) => [
  row.paymentUrl, row.stripePaymentLinkId, row.stripePaymentIntentId, row.stripeLinkAmountCents,
  row.paidAt, row.brokerFeeAllocations, row.brokerFeeFinanceUrl,
].some(value => value != null);
const wholeCents = (value: unknown): value is number => typeof value === 'number' && value >= 0 &&
  Number.isSafeInteger(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;

function ids(value: unknown, min: number, max: number): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max ||
      !value.every(isId) || new Set(value).size !== value.length) throw problem();
  return value;
}

async function readRows<K extends 'Invoice' | 'InvoiceLine' | 'Policy' | 'Carrier'>(model: K, keys: string[]) {
  return batchGetComplete<Stored<K>>({
    send: command => db.send(command), table: modelTable(model), keys: keys.map(id => ({ id })),
    maxKeys: MAX_LINES, attempts: 4, read: { ConsistentRead: true }, sizeError: problem, incompleteError: problem,
  });
}

/**
 * Group members, original drafts and pricing are frozen by the grouping
 * transaction. Read the deterministic line keys directly, including drafts
 * created before line counts were stored, so an index lag can't drop a charge.
 */
export async function loadGroupedFinance(_client: LambdaDataClient, invoiceId: string) {
  const invoice = await getModel<Stored<'Invoice'>>('Invoice', invoiceId);
  if (!invoice || invoice.sourcePricingVersion !== 3 || !['DRAFT', 'SENT'].includes(invoice.status) ||
      invoice.policyId || invoice.quoteId || invoice.adjustsInvoiceId || invoice.adjustsPremiumLineId ||
      hasPayment(invoice) || !isId(invoice.number)) throw problem();
  const policyIds = ids(invoice.groupedPolicyIds, 2, 8);
  const sourceIds = ids(invoice.groupedSourceInvoiceIds, 0, policyIds.length);
  const count = invoice.groupedLineCount;
  if (count != null && (typeof count !== 'number' || !Number.isInteger(count) || count < policyIds.length || count > MAX_LINES)) throw problem();
  const [account, members, sources, lineRows] = await Promise.all([
    getModel<Stored<'Account'>>('Account', invoice.accountId),
    readRows('Policy', policyIds),
    readRows('Invoice', sourceIds),
    readRows('InvoiceLine', Array.from({ length: MAX_LINES }, (_, i) => `${invoiceId}:${i}`)),
  ]);
  const lines = lineRows.sort((a, b) => (a.sortOrder ?? -1) - (b.sortOrder ?? -1));
  if (!account || members.length !== policyIds.length || sources.length !== sourceIds.length ||
      lines.length < policyIds.length || count != null && lines.length !== count ||
      lines.some((line, i) => line.id !== `${invoiceId}:${i}` || line.sortOrder !== i ||
        line.invoiceId !== invoiceId || line.accountId !== invoice.accountId ||
        !isId(line.policyId) || !policyIds.includes(line.policyId) || line.kind === 'BROKER_FEE' ||
        line.brokerFeeQuoteId || !wholeCents(line.retailAmount) || !wholeCents(line.costAmount))) throw problem();

  const policies = policyIds.map(id => members.find(member => member.id === id)!);
  const today = agencyDay(new Date());
  const { effectiveDate, expirationDate } = policies[0];
  if (!isRealIsoDay(effectiveDate) || !isRealIsoDay(expirationDate) || expirationDate <= effectiveDate ||
      expirationDate <= today || policies.some(policy =>
        policy.accountId !== account.id || policy.status !== 'ACTIVE' || policy.billType !== 'AGENCY' ||
        policy.groupedDraftInvoiceId !== invoiceId || policy.effectiveDate !== effectiveDate ||
        policy.expirationDate !== expirationDate || !isId(policy.policyNumber) || !isId(policy.carrierId) ||
        !policy.lines?.length || !policy.lines.every(isId) ||
        (policy.brokerFee ?? 0) !== 0 || (policy.brokerFeeCollected ?? 0) !== 0)) throw problem();

  const ordinary = policies.filter(policy => policy.carrierBillType !== 'DIRECT');
  const reviewed = invoice.groupedReviewedTotals;
  if (!Array.isArray(reviewed) || reviewed.length !== ordinary.length || sourceIds.length !== ordinary.length ||
      reviewed.some(row => !Array.isArray(row) || row.length !== 2 || !ordinary.some(policy => policy.id === row[0]) ||
        !Number.isSafeInteger(row[1]) || row[1] <= 0)) throw problem();
  const reviewedTotals = new Map<string, number>(reviewed);
  const carrierIds = [...new Set(policies.map(policy => policy.carrierId!))];
  const carriers = await readRows('Carrier', carrierIds);
  const agreementLines = policies.map(policy => {
    const source = sources.filter(row => row.policyId === policy.id);
    const policyLines = lines.filter(line => line.policyId === policy.id);
    const totals = invoiceTotals(policyLines);
    if (policy.carrierBillType === 'DIRECT') {
      const [line] = policyLines;
      if (source.length || policyLines.length !== 1 || line.kind !== 'PREMIUM' ||
          !wholeCents(policy.premium) || policy.premium <= 0 || line.retailAmount !== policy.premium ||
          line.costAmount !== policy.premium || normalizePassThroughCharges(policy.passThroughCharges).length) throw problem();
    } else {
      if (source.length !== 1 || source[0].status !== 'VOID' ||
          source[0].sourcePricingVersion !== 1 || source[0].accountId !== account.id ||
          source[0].supersededByGroupedInvoiceId !== invoiceId || source[0].sentAt ||
          source[0].invoiceSendOperation || hasPayment(source[0]) ||
          Math.round(totals.retail * 100) !== reviewedTotals.get(policy.id)) throw problem();
      validateInvoiceSourceCharges({
        invoice: { accountId: account.id, policyId: policy.id, sourcePricingVersion: 1 },
        source: policy,
        lines: policyLines,
      });
    }
    const carrier = carriers.find(row => row.id === policy.carrierId);
    if (!carrier?.name) throw problem();
    return `${carrier.name} · ${policy.policyNumber} · ${policy.lines!.join(', ')} · ${effectiveDate} to ${expirationDate} · ${formatMoney(totals.retail)}`;
  });
  const premium = financeableInvoiceTotal(lines);
  if (premium <= 0 || premium !== invoiceTotals(lines).retail) throw problem();

  const guards = [
    versionCheck(modelTable('Account'), account),
    ...policies.map(row => versionCheck(modelTable('Policy'), row)),
    ...sources.map(row => versionCheck(modelTable('Invoice'), row)),
    ...lines.map(row => versionCheck(modelTable('InvoiceLine'), row)),
  ];
  return { invoice, account, policies, lines, premium, agreementLines, guards,
    invoiceGuard: versionCheck(modelTable('Invoice'), invoice) };
}
