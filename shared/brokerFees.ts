import { decodeAwsJson } from './apiResponse';

/** Broker fees are agency revenue, separate from premium and carrier commission. */
export const BROKER_FEE_PURPOSE = 'Insurance placement and policy servicing';
export const BROKER_FEE_TERMS_VERSION = '2026-11-04.v1';
export const BROKER_FEE_REFUND_TERMS = 'Earned when coverage is bound and retained after binding, except refunds required by applicable law. If coverage is not bound, the fee is refundable.';
export interface BrokerFeeAllocation { quoteId: string; amountCents: number; policyId?: string; }
export interface BrokerFeeInvoiceSendClaim {
  invoiceId: string; token: string; createdAt: string; phase: 'PREPARING' | 'PUBLISHED';
  totalCents: number; previousLinkId: string | null; linkId?: string;
}
export interface BrokerFeeSignature { name: string; email: string; role: string; signedAt: string; consent: true; ip?: string; }
export interface BrokerFeeQuote {
  id: string; accountId: string; carrierId?: string | null; carrierName?: string | null; lines?: (string | null)[] | null;
  premium?: number | null; brokerFee?: number | null; billType?: string | null; effectiveDate?: string | null; expirationDate?: string | null;
  agencyCommissionPct?: number; agencyCommissionCents?: number;
  terms: string;
}
export interface BrokerFeeAgreement {
  id: string; kind: 'AGREEMENT'; accountId: string; accountName: string; createdAt: string; expiresAt: string;
  quotes: BrokerFeeQuote[]; totalCents: number; termsVersion: string; purpose: string; refundTerms: string;
  jurisdiction: string; stateForms: { title: string; paragraphs: string[] }[];
  agencySigner?: {name:string;title:string;licenseNumber:string;authorizedBy:string;authorizedAt:string};
  signature?: BrokerFeeSignature; signedDocumentId?: string; signedDocumentKey?: string; version: number;
}
export interface BrokerFeeRecord {
  id: string; kind: 'FEE'; accountId: string; quoteId: string; amountCents: number; terms: string; version: number;
  agreementId?: string; signedAt?: string; policyId?: string; issuedInvoiceIds?: string[]; issuedLoanIds?: string[];
  invoiceSendClaim?: BrokerFeeInvoiceSendClaim;
  submittedCents: number; collectedCents: number; refundedCents: number;
  paymentSources?: Record<string, { status: 'PROCESSING' | 'PAID' | 'FAILED' | 'REFUNDED'; amountCents: number; refundedCents: number }>;
}
export interface BrokerFeePublicTerms {
  ok: boolean; state: 'open' | 'signed' | 'closed'; reason?: string; accountName?: string;
  agreementId?: string; quotes?: Omit<BrokerFeeQuote, 'terms' | 'accountId' | 'carrierId'>[]; totalCents?: number; purpose?: string; refundTerms?: string;
  agencySigner?: Pick<NonNullable<BrokerFeeAgreement['agencySigner']>, 'name' | 'title' | 'licenseNumber'>;
  stateForms?: BrokerFeeAgreement['stateForms']; signedAt?: string; downloadUrl?: string;
  payments?: { label: string; url: string }[];
}
export function brokerFeeCents(value: number | null | undefined): number {
  if (value == null) return 0;
  if (!Number.isFinite(value) || value < 0 || value > 10_000_000 || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) throw new Error('Enter a broker fee of $0 or more with at most two decimal places.');
  return Math.round(value * 100);
}
export function assertBrokerFeeAgencyBilling(source: { brokerFee?: number | null; billType?: string | null }): void {
  if (brokerFeeCents(source.brokerFee) > 0 && source.billType !== 'AGENCY') throw new Error('Broker fees require agency billing.');
}
export function feeAllocations(value: unknown): BrokerFeeAllocation[] {
  const parsed = decodeAwsJson(value);
  if (parsed == null) return [];
  if (!Array.isArray(parsed) || parsed.length > 25) throw new Error('Invalid broker fee allocations.');
  const seen = new Set<string>();
  return parsed.map((row: BrokerFeeAllocation) => {
    if (!row || typeof row.quoteId !== 'string' || !row.quoteId || seen.has(row.quoteId) || !Number.isSafeInteger(row.amountCents) || row.amountCents <= 0) throw new Error('Invalid broker fee allocation.');
    seen.add(row.quoteId);
    return { quoteId: row.quoteId, amountCents: row.amountCents, ...(row.policyId ? { policyId: row.policyId } : {}) };
  });
}
