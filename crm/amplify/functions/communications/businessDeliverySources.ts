import type { Schema } from '../../data/resource';
import { isBusinessDeliveryFile, type BusinessDeliverySelection, type PublicProposalQuote } from '../../../../shared/frontBusinessDelivery';
import { packageAssessment, packageTerms, type CommercialPlan } from '../../../../shared/quotePackages';
import { agencyDay } from '../../../../shared/leadActionGuidance';
import { dataClient } from './data';
import { canonical, check, get, hash, type Row, type Write } from './store';
import { clientChargeBreakdown, clientChargeTotals } from '../../../../shared/clientCharges';
import { normalizePassThroughCharges } from '../../../../shared/passThroughCharges';

export function businessValidation(message: string) { return Object.assign(new Error(message), { code: 'BUSINESS_DRAFT_NOT_DISPATCHED' }); }
export type Quote = Schema['Quote']['type'];
export type Document = Schema['Document']['type'];
export interface SourceVersion { model: 'ACCOUNT' | 'QUOTE' | 'CERTIFICATE' | 'DOCUMENT' | 'CARRIER'; id: string; updatedAt: string; }
export interface SourceFile { id: string; name: string; key: string; contentType: string; }
export interface DeliverySource {
  account: Schema['Account']['type'];
  title: string; facts: string[]; quotes: PublicProposalQuote[]; quoteTerms: Record<string, string>;
  packageName?: string; requiredLines: string[]; files: SourceFile[];
  versions: SourceVersion[]; commercial?: Row<CommercialPlan>; fingerprint: string;
}
export const deliveryId = (value: unknown, label = 'record') => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw businessValidation(`Choose a valid ${label}`);
  return value;
};
export function allowedDocument(doc: Pick<Document, 'id' | 'entityType' | 'entityId' | 's3Key' | 'contentType' | 'category'> & { name?: string | null }, accountId: string, pdfOnly = false): boolean {
  const key = doc.s3Key;
  if (doc.entityType !== 'ACCOUNT' || doc.entityId !== accountId || typeof key !== 'string' ||
      key.length > 1024 || /[\\\x00-\x1f]/.test(key) || key.split('/').some(part => !part || part === '.' || part === '..') ||
      !isBusinessDeliveryFile({name:doc.name ?? key.split('/').pop(),contentType:doc.contentType,category:doc.category},pdfOnly)) return false;
  return key.startsWith(`documents/ACCOUNT/${accountId}/${doc.id}/`) && isBusinessDeliveryFile({name:key.split('/').pop(),contentType:doc.contentType},pdfOnly) ||
    doc.contentType === 'application/pdf' && doc.category === 'ACORD_FORM' && key.split('/').length === 3 && key.startsWith(`generated/${accountId}/`) && /^\d+-acord\d+-[^/]+\.pdf$/.test(key.split('/')[2]);
}
export async function deliveryAccount(accountId: string) {
  deliveryId(accountId, 'account');
  const account = await (await dataClient()).models.Account.get({ id: accountId });
  if (account.errors?.length || !account.data || account.data.id !== accountId || await get(`deleted-account:${accountId}`)) throw businessValidation('This account is unavailable');
  return account.data;
}
function version(model: SourceVersion['model'], record: { id: string; updatedAt: string }): SourceVersion {
  if (!record.updatedAt) throw businessValidation('The selected source version could not be verified');
  return { model, id: record.id, updatedAt: record.updatedAt };
}
const publicFields = ['perOccurrenceDeductible', 'perUnitDeductible', 'blanketLimit', 'coinsurancePct', 'replacementCostType', 'glEachOccurrence', 'glDamageToRentedPremises', 'glMedicalExpense', 'glPersonalAdvInjury', 'glGeneralAggregate', 'glProductsCompletedOps', 'glClaimsMade', 'glAggregateAppliesTo', 'minimumEarnedPremiumPct'] as const;
// Include private review inputs only in the server-side terms comparison, never
// in public output. Fetching a partial review input would invalidate its fence.
const quoteSourceFields = ['id', 'accountId', 'carrierId', 'status', 'premium', 'brokerFee', 'passThroughCharges', 'clientConditions', 'billType', 'commissionPct', 'lines', 'effectiveDate', 'expirationDate', 'offerExpiresAt', 'renewalPolicyId', 'notes', 'updatedAt', ...publicFields] as const;
async function sourceReads<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  // Bounded batches retain input order regardless of request completion order.
  for (let i = 0; i < items.length; i += 5) results.push(...await Promise.all(items.slice(i, i + 5).map(read)));
  return results;
}
export async function loadDeliverySource(input: BusinessDeliverySelection): Promise<DeliverySource> {
  const account = await deliveryAccount(input.accountId), client = await dataClient();
  deliveryId(input.recordId);
  if (!['PACKAGE', 'CERTIFICATE', 'DOCUMENT'].includes(input.kind)) throw businessValidation('Choose a reviewed package, certificate or document');
  const ids = input.documentIds ?? [];
  if (!Array.isArray(ids) || ids.length > 10 || new Set(ids).size !== ids.length) throw businessValidation('Choose up to 10 different PDF documents');
  ids.forEach(id => deliveryId(id, 'document'));
  if (input.kind !== 'PACKAGE' && ids.length) throw businessValidation('Additional carrier PDFs belong to a package presentation');
  const versions = [version('ACCOUNT', account)], facts: string[] = [], quotes: PublicProposalQuote[] = [], files: SourceFile[] = [], quoteTerms: Record<string, string> = {};
  let commercial: Row<CommercialPlan> | undefined, title: string, packageName: string | undefined;
  let requiredLines: string[] = [];
  if (input.kind === 'PACKAGE') {
    commercial = await get<CommercialPlan>(`commercial:${input.accountId}`);
    const option = commercial?.data.options.find(option => option.id === input.recordId);
    if (!commercial || commercial.data.accountId !== input.accountId || !option || !option.reviewed || option.quoteIds.length > 25) throw businessValidation('Choose a reviewed package option on this account');
    const sourceQuotes = await sourceReads(option.quoteIds, async id => {
      const result = await client.models.Quote.get({ id }, { selectionSet: quoteSourceFields });
      if (result.errors?.length || !result.data || result.data.id !== id || result.data.accountId !== input.accountId) throw businessValidation('A package quote is unavailable on this account');
      return result.data;
    });
    const assessment = packageAssessment(commercial.data, option, sourceQuotes, agencyDay(new Date().toISOString()));
    if (!assessment.complete) throw businessValidation(`Review the package before presenting it: ${assessment.problems.join('. ')}`);
    if (sourceQuotes.some(q => !['QUOTED', 'PRESENTED'].includes(q.status))) throw businessValidation('Only open reviewed offers can be presented');
    packageName = option.name; requiredLines = commercial.data.requiredLines;
    title = `Insurance proposal — ${account.name}`;
    facts.push(`Package: ${option.name}`, `Coverage needed: ${requiredLines.join(', ')}`);
    const carrierIds = [...new Set(sourceQuotes.map(q => q.carrierId!))];
    const sourceCarriers = await sourceReads(carrierIds, async id => {
      const result = await client.models.Carrier.get({ id }, { selectionSet: ['id', 'name', 'updatedAt'] });
      if (result.errors?.length || !result.data || result.data.id !== id) throw businessValidation('The quoted carrier is unavailable');
      return result.data;
    });
    const carriers = new Map(sourceCarriers.map(carrier => [carrier.id, carrier]));
    for (const q of sourceQuotes) {
      const carrier = carriers.get(q.carrierId!)!;
      versions.push(version('QUOTE', q), version('CARRIER', carrier));
      quoteTerms[q.id] = packageTerms(q);
      const publicQuote: PublicProposalQuote = { id: q.id, carrierName: carrier.name, premium: q.premium!, brokerFee: q.brokerFee ?? 0, billType: q.billType, lines: q.lines!.filter((line): line is string => !!line), effectiveDate: q.effectiveDate!, expirationDate: q.expirationDate!, offerExpiresAt: q.offerExpiresAt,
        passThroughCharges: normalizePassThroughCharges(q.passThroughCharges), clientConditions: q.clientConditions,
        ...Object.fromEntries(publicFields.map(field => [field, q[field] ?? null])) };
      quotes.push(publicQuote);
      facts.push(`Carrier: ${publicQuote.carrierName}`, `Coverage: ${publicQuote.lines.join(', ')}`, `Premium: ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(publicQuote.premium)}`, `Term: ${publicQuote.effectiveDate} to ${publicQuote.expirationDate}`);
      for (const charge of publicQuote.passThroughCharges!) facts.push(`${charge.description}: ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(charge.amountCents / 100)}`);
      const charges = clientChargeBreakdown(publicQuote);
      if (charges.brokerFeeCents) facts.push(`HOA broker fee: ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(charges.brokerFeeCents / 100)}`);
    }
    const totals = clientChargeTotals(quotes);
    if (totals.passThroughCents) facts.push(`Supplier fees and taxes: ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(totals.passThroughCents / 100)}`);
    if (totals.brokerFeeCents) facts.push(`Total HOA broker fees: ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(totals.brokerFeeCents / 100)}`);
    facts.push(`Total quoted policy cost: ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(totals.clientTotalCents / 100)}`);
  } else if (input.kind === 'CERTIFICATE') {
    const result = await client.models.Certificate.get({ id: input.recordId }), cert = result.data;
    if (result.errors?.length || !cert || cert.accountId !== input.accountId || cert.s3Key !== `certificates/${input.accountId}/${cert.id}.pdf`) throw businessValidation('Generate a certificate on this account before preparing it');
    versions.push(version('CERTIFICATE', cert)); title = `Certificate of insurance — ${account.name}`;
    facts.push(`Certificate holder: ${cert.holderName}`);
    files.push({ id: cert.id, name: `Certificate ${cert.certificateNumber ?? cert.id}.pdf`, key: cert.s3Key, contentType: 'application/pdf' });
  } else title = `Requested document — ${account.name}`;
  const documentIds = input.kind === 'DOCUMENT' ? [input.recordId] : ids;
  for (const id of documentIds) {
    const result = await client.models.Document.get({ id }), doc = result.data;
    if (result.errors?.length || !doc || !allowedDocument(doc, input.accountId, input.kind === 'PACKAGE')) throw businessValidation('Choose a supported account file; package attachments must be PDFs');
    versions.push(version('DOCUMENT', doc));
    files.push({ id: doc.id, name: doc.name, key: doc.s3Key!, contentType: doc.contentType! });
    facts.push(`Document: ${doc.name}`);
  }
  // Identical carrier references in a package share one source fence.
  const distinctVersions = [...new Map(versions.map(v => [`${v.model}:${v.id}`, v])).values()];
  const fingerprint = hash(canonical({ selection: { accountId: input.accountId, kind: input.kind, recordId: input.recordId, documentIds: ids }, versions: distinctVersions, commercialVersion: commercial?.version, quoteTerms, packageName, requiredLines, files }));
  return { account, title, facts, quotes, quoteTerms, packageName, requiredLines, files, versions: distinctVersions, commercial, fingerprint };
}
/** Fence the exact reviewed records before claiming the non-idempotent external POST. */
export function deliverySourceChecks(source: DeliverySource): Write[] {
  return [...source.versions.map(v => {
    const table = process.env[`${v.model}_TABLE`];
    if (!table) throw businessValidation(`Business handoff ${v.model.toLowerCase()} storage is not configured`);
    return { ConditionCheck: { TableName: table, Key: { id: v.id }, ConditionExpression: 'updatedAt = :at', ExpressionAttributeValues: { ':at': v.updatedAt } } };
  }), ...(source.commercial ? [check(source.commercial)] : [])];
}
