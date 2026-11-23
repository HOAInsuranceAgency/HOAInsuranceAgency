import { validateCollectionRoute } from '../../../shared/ipfsCollection';
import { IPFS_DISCLOSURE_VERSION, brokerFeeCents, type BrokerFeePublicTerms } from '../../../shared/brokerFees';
import { isRecord, isHttpsUrl, type ApiRecord } from '../../../shared/apiResponse';
import { publicApi } from './publicApi';
const QUERY = 'query BrokerFeeDisclosure($token: String!) { brokerFeeDisclosure(token: $token) }';
const IPFS_QUERY = 'query BrokerFeeDisclosure($token: String!, $ipfsDisclosureVersion: String!) { brokerFeeDisclosure(token: $token, ipfsDisclosureVersion: $ipfsDisclosureVersion) }';
const IPFS_SIGN = 'mutation SignBrokerFeeDisclosure($token: String!, $signerName: String!, $signerEmail: String!, $signerRole: String!, $consent: Boolean!, $ipfsDisclosureVersion: String!) { signBrokerFeeDisclosure(token: $token, signerName: $signerName, signerEmail: $signerEmail, signerRole: $signerRole, consent: $consent, ipfsDisclosureVersion: $ipfsDisclosureVersion) }';
const SIGN = 'mutation SignBrokerFeeDisclosure($token: String!, $signerName: String!, $signerEmail: String!, $signerRole: String!, $consent: Boolean!) { signBrokerFeeDisclosure(token: $token, signerName: $signerName, signerEmail: $signerEmail, signerRole: $signerRole, consent: $consent) }';
function isDisclosure(value: ApiRecord): value is ApiRecord & BrokerFeePublicTerms {
  const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
  const textList = (value: unknown) => Array.isArray(value) && value.every(item => text(item));
  const optionalText = (value: unknown) => value == null || typeof value === 'string';
  const amount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (value.ok !== true || !['open', 'signed', 'closed'].includes(String(value.state)) || !optionalText(value.reason)) return false;
  if (value.state === 'closed') return true;
  if (!['accountName', 'agreementId', 'purpose', 'refundTerms'].every(key => text(value[key]))
    || !Number.isSafeInteger(value.totalCents) || Number(value.totalCents) <= 0
    || !Array.isArray(value.quotes) || !value.quotes.length || !Array.isArray(value.stateForms)) return false;
  let total = 0;
  for (const quote of value.quotes) {
    if (!isRecord(quote) || !text(quote.id)
      || quote.lines != null && (!Array.isArray(quote.lines) || !quote.lines.every(line => line === null || typeof line === 'string'))
      || !optionalText(quote.carrierName) || quote.premium != null && !amount(quote.premium) || quote.brokerFee != null && !amount(quote.brokerFee)
      || !optionalText(quote.effectiveDate) || !optionalText(quote.expirationDate) || !optionalText(quote.billType)) return false;
    // State eligibility requires visible coverage for charged policies. Other
    // display fields, and uncharged package policies, retain their wire nulls.
    if (Number(quote.brokerFee ?? 0) > 0 && (!Array.isArray(quote.lines) || !quote.lines.some(text))) return false;
    if (quote.agencyCommissionPct != null || quote.agencyCommissionCents != null) {
      if (!amount(quote.agencyCommissionPct) || quote.agencyCommissionPct > 100 || !Number.isSafeInteger(quote.agencyCommissionCents) || Number(quote.agencyCommissionCents) < 0) return false;
    }
    const priorFees = quote.ipfsPriorBrokerFees ?? 0;
    if (!amount(priorFees)) return false;
    try {
      validateCollectionRoute({ ipfsAmountFinanced: quote.ipfsAmountFinanced, ipfsPriorBrokerFees: priorFees, billType: quote.billType });
      total += brokerFeeCents(quote.brokerFee);
    } catch { return false; }
  }
  if (!Number.isSafeInteger(total) || total !== value.totalCents) return false;
  if (!value.stateForms.every(form => isRecord(form) && text(form.title) && textList(form.paragraphs))) return false;
  if (value.agencySigner !== undefined && (!isRecord(value.agencySigner) || !text(value.agencySigner.name) || !text(value.agencySigner.title) || !text(value.agencySigner.licenseNumber))) return false;
  if (value.state === 'signed' && (!text(value.signedAt) || !Number.isFinite(Date.parse(value.signedAt)))) return false;
  return (value.downloadUrl === undefined || isHttpsUrl(value.downloadUrl))
    && (value.payments === undefined || Array.isArray(value.payments) && value.payments.every(payment => isRecord(payment) && text(payment.label) && isHttpsUrl(payment.url)));
}
async function call(query: string, variables: Record<string, unknown>, field: string): Promise<BrokerFeePublicTerms> {
  const url = import.meta.env.PUBLIC_CRM_API_URL, key = import.meta.env.PUBLIC_CRM_API_KEY;
  const result = await publicApi(query, variables, field, {
    url, key, configurationError: 'Client fee disclosures are unavailable on this build.',
    httpError: 'The disclosure could not be loaded. Please retry.',
    graphQLError: 'This disclosure request could not be completed. Please retry.',
    invalid: 'The disclosure response was unreadable.', refused: 'This disclosure request could not be completed. Please retry.',
    request: { credentials: 'omit', referrerPolicy: 'no-referrer' },
  });
  if (!isDisclosure(result)) throw new Error('The disclosure response was unreadable.');
  return result;
}
export async function loadBrokerFeeDisclosure(token: string) {
  // Start with the legacy query while the web and API deploy independently.
  const result = await call(QUERY, { token }, 'brokerFeeDisclosure');
  return result.state === 'closed' && result.requiresIpfsDisclosureVersion === true
    ? call(IPFS_QUERY, { token, ipfsDisclosureVersion: IPFS_DISCLOSURE_VERSION }, 'brokerFeeDisclosure')
    : result;
}
export const signBrokerFeeDisclosure = (token: string, signer: { signerName: string; signerEmail: string; signerRole: string; consent: boolean; ipfsDisclosureVersion?: string }) => call(signer.ipfsDisclosureVersion ? IPFS_SIGN : SIGN, { token, ...signer }, 'signBrokerFeeDisclosure');
