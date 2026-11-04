import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BROKER_FEE_PURPOSE, BROKER_FEE_REFUND_TERMS, BROKER_FEE_TERMS_VERSION, brokerFeeCents, type BrokerFeeAgreement, type BrokerFeePublicTerms, type BrokerFeeQuote, type BrokerFeeRecord, type BrokerFeeSignature } from '../../../../shared/brokerFees';
import { authorizedQuoteTerms } from '../../../../shared/quoteAuthorization';
import { assertBrokerFeeAgencyBilling, feeAllocations } from '../../../../shared/brokerFees';
import { getRow, getFee, getAgreement, getModel, modelTable, table, feePut, versionCheck, transact, accountModels, type Write } from './store';
import { createBrokerFeeDisclosurePdf } from './disclosurePdf';

const s3 = new S3Client();
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
type Model = Record<string, unknown> & { id: string; updatedAt: string };
interface TokenRecord { id: string; agreementId: string; expiresAt: string; version: number; }
const frozenAgencySigner = (rule: BrokerFeeJurisdictionRule) => rule.requiresBrokerSignature && rule.agencySigner ? { name: rule.agencySigner.name, title: rule.agencySigner.title, licenseNumber: rule.agencySigner.licenseNumber, authorizedBy: rule.agencySigner.authorizedBy!, authorizedAt: rule.agencySigner.authorizedAt! } : undefined;
/** State rules are agency-reviewed configuration, never inferred from a fee checkbox. */
export interface BrokerFeeJurisdictionRule {
  approved: true; version: string; reviewedAt: string; reviewedBy: string; evidenceUrl: string;
  allowedLines: string[]; allowedBillTypes: ('AGENCY' | 'DIRECT')[];
  allowsCarrierCommission: true; maxFeeCents: number | null;
  forms: { title: string; paragraphs: string[] }[];
  requiresBrokerSignature?: boolean;
  discloseCarrierCommission?: boolean;
  agencySigner?: { name: string; title: string; licenseNumber: string; authorized: true; authorizedBy?: string; authorizedAt?: string };
}
export function jurisdictionRule(raw: unknown, state: string, quotes: Pick<BrokerFeeQuote, 'lines' | 'brokerFee' | 'billType'>[], billType?: string): BrokerFeeJurisdictionRule {
  for(const quote of quotes)assertBrokerFeeAgencyBilling({...quote,billType:billType||quote.billType});
  let settings: unknown = raw;
  if (typeof settings === 'string') { try { settings = JSON.parse(settings); } catch { throw new Error('Broker fee jurisdiction settings need review.'); } }
  const rule = settings && typeof settings === 'object' ? (settings as Record<string, BrokerFeeJurisdictionRule>)[state] : undefined;
  if (!/^[A-Z]{2}$/.test(state) || !rule || rule.approved !== true || !rule.version?.trim() || !rule.reviewedBy?.trim() || !Number.isFinite(Date.parse(rule.reviewedAt)) || Date.parse(rule.reviewedAt) > Date.now() || !/^https:\/\//.test(rule.evidenceUrl ?? '') || rule.allowsCarrierCommission !== true || !Array.isArray(rule.allowedLines) || !rule.allowedLines.length || rule.allowedLines.some(value => typeof value !== 'string' || !value.trim()) || !Array.isArray(rule.allowedBillTypes) || !rule.allowedBillTypes.length || rule.allowedBillTypes.some(value => !['AGENCY', 'DIRECT'].includes(value)) || !Object.hasOwn(rule, 'maxFeeCents') || rule.maxFeeCents !== null && (!Number.isSafeInteger(rule.maxFeeCents) || rule.maxFeeCents < 0)) throw new Error(`Broker fee disclosures have not been configured for ${state || 'this state'}.`);
  if (billType && !rule.allowedBillTypes.includes(billType as 'AGENCY' | 'DIRECT')) throw new Error('Broker fees are not configured for this billing method in this state.');
  const permitted = new Set(rule.allowedLines.map(value => value.trim().toLowerCase()));
  for (const quote of quotes) if (brokerFeeCents(quote.brokerFee) > 0) {
    if (!['AGENCY', 'DIRECT'].includes(String(billType || quote.billType)) || !rule.allowedBillTypes.includes((billType || quote.billType) as 'AGENCY' | 'DIRECT')) throw new Error('Choose a permitted billing method on the fee quote before preparing its disclosure.');
    if (!(quote.lines ?? []).filter(Boolean).length || (quote.lines ?? []).some(line => line && !permitted.has('*') && !permitted.has(line.trim().toLowerCase()))) throw new Error('Broker fees are not configured for these coverage lines in this state.');
    if (rule.maxFeeCents !== null && brokerFeeCents(quote.brokerFee) > rule.maxFeeCents) throw new Error('The broker fee exceeds the configured state limit.');
  }
  if (!Array.isArray(rule.forms) || rule.forms.length > 10 || rule.forms.some(form => !form.title?.trim() || form.title.length > 160 || !Array.isArray(form.paragraphs) || !form.paragraphs.length || form.paragraphs.length > 30 || form.paragraphs.some(value => typeof value !== 'string' || !value.trim() || value.length > 5000))) throw new Error('The approved state disclosure forms need review.');
  if (Buffer.byteLength(JSON.stringify(rule)) > 150_000) throw new Error('The approved state disclosure forms are too large.');
  if (rule.requiresBrokerSignature && (!rule.agencySigner || rule.agencySigner.authorized !== true || ['name', 'title', 'licenseNumber', 'authorizedBy'].some(field => typeof rule.agencySigner?.[field as 'name'] !== 'string' || !rule.agencySigner[field as 'name'].trim() || rule.agencySigner[field as 'name'].length > 120) || !Number.isFinite(Date.parse(rule.agencySigner.authorizedAt ?? '')) || Date.parse(rule.agencySigner.authorizedAt!) > Date.now())) throw new Error('Configure the authorized agency signer required by this state disclosure.');
  return rule;
}
function unavailable(): never { throw new Error('This fee disclosure is no longer available. Ask your agency for the current proposal.'); }
async function accountSources(accountId: string) {
  const account = await getModel<Model>('Account', accountId);
  if (!account || await getModel('Communication', `deleted-account:${accountId}`)) unavailable();
  const settings = await getModel<Model>('AgencySettings', 'AGENCY');
  return { account, settings };
}
function deletedCheck(accountId: string): Write {
  return { ConditionCheck: { TableName: modelTable('Communication'), Key: { id: `deleted-account:${accountId}` }, ConditionExpression: 'attribute_not_exists(id)' } };
}
function sameQuote(current: Model, frozen: BrokerFeeQuote) {
  return current.accountId === frozen.accountId && brokerFeeCents(current.brokerFee as number | null) === brokerFeeCents(frozen.brokerFee) && authorizedQuoteTerms(current) === frozen.terms && (frozen.agencyCommissionPct === undefined || current.commissionPct === frozen.agencyCommissionPct && Math.round(Number(current.premium) * frozen.agencyCommissionPct) === frozen.agencyCommissionCents);
}
export async function prepareBrokerFeeAgreement(accountId: string, quotes: BrokerFeeQuote[], jurisdiction?: string, options: { reuseContainingAgreement?: boolean } = {}): Promise<{ url: string; agreementId: string }> {
  if (!quotes.length || quotes.length > 25 || new Set(quotes.map(quote => quote.id)).size !== quotes.length) throw new Error('Choose a package containing up to 25 different policies.');
  const { account, settings } = await accountSources(accountId), state = String(account.state ?? '').trim().toUpperCase();
  if (jurisdiction && jurisdiction !== state) throw new Error('The fee disclosure state does not match the account.');
  const rule = jurisdictionRule(settings?.brokerFeeJurisdictions, state, quotes);
  const sources = await Promise.all(quotes.map(quote => getModel<Model>('Quote', quote.id)));
  sources.forEach((source, index) => { if (!source || quotes[index].accountId !== accountId || !sameQuote(source, quotes[index]) || !['QUOTED', 'PRESENTED'].includes(String(source.status))) throw new Error('The package changed. Review the current quote terms before preparing its fee disclosure.'); });
  quotes = quotes.map((quote, index) => {
    const { agencyCommissionPct: _pct, agencyCommissionCents: _cents, ...base } = quote;
    if (!rule.discloseCarrierCommission) return base;
    const rate = sources[index]!.commissionPct;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 100) throw new Error('Record the exact carrier commission before preparing the required compensation disclosure.');
    return { ...base, agencyCommissionPct: rate, agencyCommissionCents: Math.round(Number(sources[index]!.premium) * rate) };
  });
  const totalCents = quotes.reduce((total, quote) => total + brokerFeeCents(quote.brokerFee), 0);
  if (!totalCents || !Number.isSafeInteger(totalCents)) throw new Error('This package has no broker fee to disclose.');
  const site = new URL(process.env.SITE_URL ?? '');
  if (site.protocol !== 'https:' || site.username || site.password) throw new Error('The client disclosure site is not configured.');
  const fees = await Promise.all(quotes.map(quote => getFee(quote.id)));
  const token = randomBytes(32).toString('base64url'), createdAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 14 * 86_400_000).toISOString();
  const feeRows = fees.filter((fee): fee is BrokerFeeRecord => !!fee);
  const priorIds = new Set(feeRows.map(fee => fee.agreementId));
  const candidate = priorIds.size === 1 && feeRows.length === quotes.filter(quote => brokerFeeCents(quote.brokerFee) > 0).length && feeRows[0].agreementId ? await getAgreement(feeRows[0].agreementId) : undefined;
  const group = (values: BrokerFeeQuote[]) => JSON.stringify(values.map(quote => [quote.id, quote.terms, quote.agencyCommissionPct ?? null, quote.agencyCommissionCents ?? null] as const).sort((a, b) => a[0].localeCompare(b[0])));
  const matchesGroup = candidate && (group(candidate.quotes) === group(quotes) || options.reuseContainingAgreement && quotes.every(quote => candidate.quotes.some(frozen => group([frozen]) === group([quote]))));
  let reused = candidate && candidate.accountId === accountId && candidate.accountName === String(account.legalName || account.name) && candidate.jurisdiction === state && candidate.termsVersion === `${BROKER_FEE_TERMS_VERSION}:${rule.version}` && matchesGroup && JSON.stringify(candidate.stateForms) === JSON.stringify(rule.forms) && JSON.stringify(candidate.agencySigner) === JSON.stringify(frozenAgencySigner(rule)) && (candidate.signature || Date.parse(candidate.expiresAt) > Date.now()) ? candidate : undefined;
  const fencedSources = new Map(sources.map(source => [source!.id, source!]));
  if (reused) {
    for (const frozen of reused.quotes) {
      const current = fencedSources.get(frozen.id) ?? await getModel<Model>('Quote', frozen.id);
      if (!current || !sameQuote(current, frozen) || !['QUOTED', 'PRESENTED', ...(reused.signature ? ['BOUND'] : [])].includes(String(current.status))) { reused = undefined; break; }
      fencedSources.set(current.id, current);
    }
  }
  const agreementId = reused?.id ?? `bfa_${randomUUID().replace(/-/g, '')}`;
  const agreement: BrokerFeeAgreement = reused ?? { id: agreementId, kind: 'AGREEMENT', accountId, accountName: String(account.legalName || account.name), createdAt, expiresAt, quotes, totalCents, termsVersion: `${BROKER_FEE_TERMS_VERSION}:${rule.version}`, purpose: BROKER_FEE_PURPOSE, refundTerms: BROKER_FEE_REFUND_TERMS, jurisdiction: state, stateForms: rule.forms, ...(frozenAgencySigner(rule) ? { agencySigner: frozenAgencySigner(rule) } : {}), version: 1 };
  const writes: Write[] = [reused ? versionCheck(table(), reused) : feePut(agreement), feePut({ id: `token:${sha(token)}`, agreementId, expiresAt, version: 1 } as TokenRecord), versionCheck(modelTable('Account'), account), deletedCheck(accountId), ...[...fencedSources.values()].map(source => versionCheck(modelTable('Quote'), source))];
  if (settings) writes.push(versionCheck(modelTable('AgencySettings'), settings));
  for (const [index, quote] of quotes.entries()) {
    const amountCents = brokerFeeCents(quote.brokerFee); if (!amountCents) continue;
    const previous = fees[index];
    if (previous && previous.accountId !== accountId) throw new Error('This fee belongs to a different account.');
    if (previous && (previous.terms !== quote.terms || previous.amountCents !== amountCents) && (previous.submittedCents > 0 || previous.collectedCents > 0 || previous.policyId)) throw new Error('This fee already has payment or bound-policy history. Resolve its existing billing before changing the fee.');
    const unchanged = previous?.terms === quote.terms && previous.amountCents === amountCents;
    if (unchanged && !previous!.signedAt && previous!.agreementId !== agreementId) writes.push(feePut({ ...previous!, agreementId }, previous));
    else if (unchanged) writes.push(versionCheck(table(), previous!));
    else writes.push(feePut({ id: `fee:${quote.id}`, kind: 'FEE', accountId, quoteId: quote.id, amountCents, terms: quote.terms, agreementId, version: 1, submittedCents: 0, collectedCents: 0, refundedCents: 0 } as BrokerFeeRecord, previous));
  }
  await transact(writes);
  site.pathname = '/broker-fee/'; site.search = ''; site.hash = ''; site.searchParams.set('t', token);
  return { url: site.toString(), agreementId };
}
async function currentAgreement(token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) unavailable();
  const link = await getRow<TokenRecord>(`token:${sha(token)}`);
  if (!link || Date.parse(link.expiresAt) <= Date.now()) unavailable();
  const agreement = await getAgreement(link.agreementId);
  if (!agreement || !agreement.signature && Date.parse(agreement.expiresAt) <= Date.now()) unavailable();
  const { account, settings } = await accountSources(agreement.accountId), quotes = await Promise.all(agreement.quotes.map(quote => getModel<Model>('Quote', quote.id)));
  const state = String(account.state ?? '').trim().toUpperCase(), rule = jurisdictionRule(settings?.brokerFeeJurisdictions, state, agreement.quotes);
  if (agreement.jurisdiction !== state || agreement.accountName !== String(account.legalName || account.name) || agreement.termsVersion !== `${BROKER_FEE_TERMS_VERSION}:${rule.version}` || JSON.stringify(agreement.stateForms) !== JSON.stringify(rule.forms) || JSON.stringify(agreement.agencySigner) !== JSON.stringify(frozenAgencySigner(rule))) unavailable();
  for (const [index, frozen] of agreement.quotes.entries()) {
    const current = quotes[index];
    if (!current || !sameQuote(current, frozen) || !['QUOTED', 'PRESENTED', ...(agreement.signature ? ['BOUND'] : [])].includes(String(current.status))) unavailable();
  }
  return { link, agreement, account, settings, quotes: quotes as Model[] };
}
export function safePaymentUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port && ['buy.stripe.com', 'checkout.stripe.com'].includes(url.hostname); } catch { return false; }
}
function safeFinanceUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value), site = new URL(process.env.SITE_URL ?? ''); return url.protocol === 'https:' && url.origin === site.origin && !url.username && !url.password && !url.hash && /^\/finance\/?$/.test(url.pathname) && !!url.searchParams.get('t'); } catch { return false; }
}
async function readInBatches<T, R>(values: readonly T[], read: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < values.length; offset += 5) results.push(...await Promise.all(values.slice(offset, offset + 5).map(read)));
  return results;
}
async function termsDto(agreement: BrokerFeeAgreement): Promise<BrokerFeePublicTerms> {
  const dto: BrokerFeePublicTerms = { ok: true, state: agreement.signature ? 'signed' : 'open', accountName: agreement.accountName, agreementId: agreement.id, quotes: agreement.quotes.map(quote => ({ id: quote.id, carrierName: quote.carrierName, lines: quote.lines, premium: quote.premium, brokerFee: quote.brokerFee, billType: quote.billType, effectiveDate: quote.effectiveDate, expirationDate: quote.expirationDate, ...(quote.agencyCommissionPct !== undefined ? { agencyCommissionPct: quote.agencyCommissionPct, agencyCommissionCents: quote.agencyCommissionCents } : {}) })), totalCents: agreement.totalCents, purpose: agreement.purpose, refundTerms: agreement.refundTerms, stateForms: agreement.stateForms };
  if (agreement.agencySigner) dto.agencySigner = { name: agreement.agencySigner.name, title: agreement.agencySigner.title, licenseNumber: agreement.agencySigner.licenseNumber };
  if (!agreement.signature) return dto;
  dto.signedAt = agreement.signature.signedAt;
  if (agreement.signedDocumentKey) dto.downloadUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.DOCUMENT_BUCKET!, Key: agreement.signedDocumentKey }), { expiresIn: 300 });
  const ids = new Set(agreement.quotes.map(quote => quote.id));
  const listed = await accountModels<Record<string, unknown>>('Invoice', agreement.accountId);
  // The GSI supplies candidates only. Frozen allocations retain the covered
  // quote association when binding adds/replaces the invoice's policy anchor.
  const candidateIds = [...new Set(listed.filter(invoice => {
    if (invoice.accountId !== agreement.accountId || typeof invoice.id !== 'string' || !invoice.id || !['SENT', 'PROCESSING'].includes(String(invoice.status)) || !safePaymentUrl(invoice.paymentUrl) && !safeFinanceUrl(invoice.brokerFeeFinanceUrl)) return false;
    try { return feeAllocations(invoice.brokerFeeAllocations).some(allocation => ids.has(allocation.quoteId)); }
    catch { return false; } // An invalid index projection cannot authorize a payment link.
  }).map(invoice => String(invoice.id)))];
  const invoices = await readInBatches(candidateIds, invoiceId => getModel<Record<string, unknown>>('Invoice', invoiceId));
  const payable: Record<string, unknown>[] = [];
  for (const invoice of invoices) {
    if (!invoice || invoice.accountId !== agreement.accountId || invoice.status !== 'SENT' || !safePaymentUrl(invoice.paymentUrl) && !safeFinanceUrl(invoice.brokerFeeFinanceUrl)) continue;
    const allocations = feeAllocations(invoice.brokerFeeAllocations);
    if (!allocations.some(allocation => ids.has(allocation.quoteId))) continue;
    const fees = await readInBatches(allocations, allocation => getFee(allocation.quoteId));
    if (fees.some((fee, index) => !fee?.signedAt || fee.accountId !== agreement.accountId || fee.amountCents !== allocations[index].amountCents)) continue;
    payable.push(invoice);
  }
  dto.payments = payable.flatMap(invoice => [
    ...(safePaymentUrl(invoice.paymentUrl) ? [{ label: `Pay invoice ${invoice.number || ''} in full`.trim(), url: String(invoice.paymentUrl) }] : []),
    ...(safeFinanceUrl(invoice.brokerFeeFinanceUrl) ? [{ label: `Finance the premium and pay broker fees upfront${invoice.number ? ` - ${invoice.number}` : ''}`, url: String(invoice.brokerFeeFinanceUrl) }] : []),
  ]);
  return dto;
}
export async function brokerFeeDisclosure(token: string): Promise<BrokerFeePublicTerms> {
  try { return await termsDto((await currentAgreement(token)).agreement); }
  catch (error) { if (error instanceof Error && (error.message.startsWith('This fee disclosure')||error.message==='Broker fees require agency billing.')) return { ok: true, state: 'closed', reason: error.message }; throw error; }
}
export async function signBrokerFeeDisclosure(token: string, signer: { signerName: unknown; signerEmail: unknown; signerRole: unknown; consent: unknown }, ip?: string): Promise<BrokerFeePublicTerms> {
  const current = await currentAgreement(token), { agreement, account, settings, quotes, link } = current;
  if (agreement.signature) return termsDto(agreement);
  const clean = (value: unknown, max: number) => typeof value === 'string' && !/[\x00-\x1f\x7f]/.test(value) && value.trim().length <= max ? value.trim() : '';
  const name = clean(signer.signerName, 120), email = clean(signer.signerEmail, 254).toLowerCase(), role = clean(signer.signerRole, 80);
  if (signer.consent !== true || name.length < 2 || role.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter your name, email and role, and consent to signing electronically.');
  const signature: BrokerFeeSignature = { name, email, role, consent: true, signedAt: new Date().toISOString(), ...(ip ? { ip: ip.slice(0, 80) } : {}) };
  const documentId = `bfd_${randomUUID().replace(/-/g, '')}`, key = `documents/ACCOUNT/${agreement.accountId}/${documentId}/signed-broker-fee-disclosure.pdf`;
  const signed: BrokerFeeAgreement = { ...agreement, signature, signedDocumentId: documentId, signedDocumentKey: key };
  const pdf = await createBrokerFeeDisclosurePdf(signed);
  await s3.send(new PutObjectCommand({ Bucket: process.env.DOCUMENT_BUCKET!, Key: key, Body: pdf.bytes, ContentType: 'application/pdf', IfNoneMatch: '*' }));
  const writes: Write[] = [feePut(signed, agreement), versionCheck(table(), link),
    { Update: { TableName: modelTable('Account'), Key: { id: account.id }, UpdateExpression: 'SET brokerFeeHistory = :history, updatedAt = :now', ConditionExpression: 'updatedAt = :old', ExpressionAttributeValues: { ':history': true, ':now': signature.signedAt, ':old': account.updatedAt } } },
    deletedCheck(agreement.accountId), ...quotes.map(quote => versionCheck(modelTable('Quote'), quote))];
  if (settings) writes.push(versionCheck(modelTable('AgencySettings'), settings));
  for (const frozen of agreement.quotes) {
    if (!brokerFeeCents(frozen.brokerFee)) continue;
    const fee = await getFee(frozen.id);
    if (!fee || fee.accountId !== agreement.accountId || fee.terms !== frozen.terms || fee.amountCents !== brokerFeeCents(frozen.brokerFee) || fee.policyId) unavailable();
    writes.push(feePut({ ...fee, agreementId: agreement.id, signedAt: signature.signedAt }, fee));
  }
  writes.push({ Put: { TableName: modelTable('Document'), Item: { id: documentId, __typename: 'Document', entityType: 'ACCOUNT', entityId: agreement.accountId, quoteId: agreement.quotes[0].id, quoteIds: agreement.quotes.map(quote => quote.id), policyIds: [], category: 'BROKER_FEE_DISCLOSURE', name: 'Signed broker fee disclosure.pdf', s3Key: key, contentType: 'application/pdf', sizeBytes: pdf.bytes.length, uploadedBy: 'broker-fee-signature', lastWriteBy: 'broker-fee-signature', ocrStatus: 'SKIPPED', createdAt: signature.signedAt, updatedAt: signature.signedAt, brokerFeeAgreementId: agreement.id, sha256: sha(pdf.bytes), signatureEvidenceSha256: sha(JSON.stringify({ agreementId: agreement.id, quotes: agreement.quotes, termsVersion: agreement.termsVersion, signature })) }, ConditionExpression: 'attribute_not_exists(id)' } });
  try { await transact(writes); }
  catch (error) {
    const latest = await getAgreement(agreement.id);
    if (!latest?.signature) throw error;
    return termsDto((await currentAgreement(token)).agreement);
  }
  return termsDto({ ...signed, version: agreement.version + 1 });
}
