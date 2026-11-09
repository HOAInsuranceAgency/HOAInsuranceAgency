import { isHttpsUrl, type ApiRecord } from './apiResponse';

/** Public figures only; no account IDs, underwriting notes, or internal loan state. */
export interface FinanceElectionOffer {
  ok: true; state: 'open' | 'done' | 'active'; associationName: string;
  premium: number; months: number; apr: number; downPayment: number;
  initialPaymentAmount?: number; amountFinanced: number; payment: number;
  totalInterest: number; originationFee: number; brokerFee?: number;
  effectiveDate: string | null; agreementTerms: string[];
  financingOnly?: true;
  finalPayment?: number;
  agreementSignedName: string | null; agreementSignedRole: string | null;
}
export interface FinanceElectionClosed { ok: true; state: 'closed'; reason?: string }
export type FinanceElectionTermsResponse = FinanceElectionOffer | FinanceElectionClosed;
export type FinanceElectionAcceptance = FinanceElectionClosed | { ok: true; state: 'done' } | { ok: true; state: 'checkout'; url: string };
const finiteAmount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const optionalText = (value: unknown) => value == null || typeof value === 'string';

export function isFinanceElectionTerms(value: ApiRecord): value is ApiRecord & FinanceElectionTermsResponse {
  if (value.ok !== true) return false;
  if (value.state === 'closed') return optionalText(value.reason);
  return ['open', 'done', 'active'].includes(String(value.state)) && typeof value.associationName === 'string'
    && ['premium', 'apr', 'downPayment', 'amountFinanced', 'payment', 'totalInterest', 'originationFee'].every(key => finiteAmount(value[key]))
    && typeof value.months === 'number' && Number.isSafeInteger(value.months) && value.months > 0
    && (value.brokerFee === undefined || finiteAmount(value.brokerFee))
    && (value.initialPaymentAmount === undefined || finiteAmount(value.initialPaymentAmount))
    && (value.financingOnly === undefined || value.financingOnly === true)
    && (value.finalPayment === undefined ? value.financingOnly !== true || value.state !== 'open' : finiteAmount(value.finalPayment))
    && optionalText(value.effectiveDate) && optionalText(value.agreementSignedName) && optionalText(value.agreementSignedRole)
    && Array.isArray(value.agreementTerms) && (value.state !== 'open' || value.agreementTerms.length > 0) && value.agreementTerms.every(term => typeof term === 'string');
}

export function isFinanceElectionAcceptance(value: ApiRecord): value is ApiRecord & FinanceElectionAcceptance {
  if (value.ok !== true) return false;
  if (value.state === 'done') return true;
  if (value.state === 'closed') return optionalText(value.reason);
  return value.state === 'checkout' && isHttpsUrl(value.url);
}

