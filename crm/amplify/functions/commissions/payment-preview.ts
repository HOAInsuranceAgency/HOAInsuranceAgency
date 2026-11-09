import { AccountAccess } from '../crm-access/access';
import { isActiveOwner } from '../crm-access/active-role';
import { day, required, selectCarrierPaymentTerms, type CarrierCommissionTerms } from '../../../../shared/commissions';
import { get } from './store';
import type { Event } from './handler';

/** Quote-scoped summary. Never send contract evidence or other arrangements to
 * a producer; previewing a carrier must not grant access to its private ledger. */
export async function previewCarrierPaymentTerms(event: Event) {
  const quoteId = required(event.arguments?.quoteId, 'a quote'),
    billType = event.arguments?.billType,
    issuedRenewal = event.arguments?.issuedRenewal === true;
  if (billType !== 'AGENCY' && billType !== 'DIRECT') throw new Error('Choose a bill type.');
  if (issuedRenewal && !isActiveOwner(event.identity, event.request))
    throw new Error('Only the active Owner can record an already-issued renewal.');
  const quote = await new AccountAccess(event.identity, undefined, event.request)
    .requireRecord('Quote', quoteId);
  if (issuedRenewal && quote.billType != null && quote.billType !== billType)
    throw new Error('The carrier’s billing type must match the recorded quote.');
  const terms = await get<CarrierCommissionTerms>('CARRIER', required(quote.carrierId, 'a carrier'));
  if (!terms) throw new Error('An Owner must configure this carrier’s commission payment terms before binding.');
  const selected = selectCarrierPaymentTerms(terms, {
    effectiveDate: day(quote.effectiveDate),
    lines: Array.isArray(quote.lines) ? quote.lines.filter((v): v is string => typeof v === 'string') : [],
    billType,
    transaction: issuedRenewal || quote.renewalPolicyId ? 'RENEWAL' : 'NEW',
  });
  const p = selected.payment;
  return {
    carrierTermsVersion: terms.version,
    basis: selected.basis,
    ...(p ? { payment: {
      id: p.id,
      payor: p.payor,
      trigger: p.trigger,
      cadence: p.cadence,
      lagDays: p.lagDays,
      ...(p.cutoffDay !== undefined ? { cutoffDay: p.cutoffDay } : {}),
      ...(p.paymentDay !== undefined ? { paymentDay: p.paymentDay } : {}),
      ...(p.earningMethod ? { earningMethod: p.earningMethod } : {}),
    } } : {}),
  };
}
