import { ipfsFeeSplit, usesIpfs, validateCollectionRoute } from '../../../shared/ipfsCollection';
import { IPFS_DISCLOSURE_VERSION, type BrokerFeePublicTerms } from '../../../shared/brokerFees';
import { assertWebsiteActionsEnabled } from './migrationPreview';
const QUERY = 'query BrokerFeeDisclosure($token: String!) { brokerFeeDisclosure(token: $token) }';
const IPFS_QUERY = 'query BrokerFeeDisclosure($token: String!, $ipfsDisclosureVersion: String!) { brokerFeeDisclosure(token: $token, ipfsDisclosureVersion: $ipfsDisclosureVersion) }';
const IPFS_SIGN = 'mutation SignBrokerFeeDisclosure($token: String!, $signerName: String!, $signerEmail: String!, $signerRole: String!, $consent: Boolean!, $ipfsDisclosureVersion: String!) { signBrokerFeeDisclosure(token: $token, signerName: $signerName, signerEmail: $signerEmail, signerRole: $signerRole, consent: $consent, ipfsDisclosureVersion: $ipfsDisclosureVersion) }';
const SIGN = 'mutation SignBrokerFeeDisclosure($token: String!, $signerName: String!, $signerEmail: String!, $signerRole: String!, $consent: Boolean!) { signBrokerFeeDisclosure(token: $token, signerName: $signerName, signerEmail: $signerEmail, signerRole: $signerRole, consent: $consent) }';
async function call(query: string, variables: Record<string, unknown>, field: string): Promise<BrokerFeePublicTerms> {
  const url = import.meta.env.PUBLIC_CRM_API_URL, key = import.meta.env.PUBLIC_CRM_API_KEY;
  if (!url || !key) throw new Error('Client fee disclosures are unavailable on this build.');
  assertWebsiteActionsEnabled();
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ query, variables }), credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error('The disclosure could not be loaded. Please retry.');
  const body = await response.json();
  if (body.errors?.length) throw new Error('This disclosure request could not be completed. Please retry.');
  let result: unknown = body.data?.[field];
  for (let i = 0; i < 2 && typeof result === 'string'; i++) { try { result = JSON.parse(result); } catch { throw new Error('The disclosure response was unreadable.'); } }
  if (!result || typeof result !== 'object' || (result as BrokerFeePublicTerms).ok !== true) throw new Error(String((result as { error?: string } | null)?.error || 'This disclosure request could not be completed. Please retry.'));
  const terms = result as BrokerFeePublicTerms;
  if (terms.state !== 'closed') {
    try {
      for (const quote of terms.quotes ?? []) {
        validateCollectionRoute(quote);
        if (usesIpfs(quote)) ipfsFeeSplit(quote);
      }
    } catch { throw new Error('The disclosure response was unreadable.'); }
  }
  return terms;
}
export async function loadBrokerFeeDisclosure(token: string) {
  // Start with the legacy query while the web and API deploy independently.
  const result = await call(QUERY, { token }, 'brokerFeeDisclosure');
  return result.state === 'closed' && result.requiresIpfsDisclosureVersion === true
    ? call(IPFS_QUERY, { token, ipfsDisclosureVersion: IPFS_DISCLOSURE_VERSION }, 'brokerFeeDisclosure')
    : result;
}
export const signBrokerFeeDisclosure = (token: string, signer: { signerName: string; signerEmail: string; signerRole: string; consent: boolean; ipfsDisclosureVersion?: string }) => call(signer.ipfsDisclosureVersion ? IPFS_SIGN : SIGN, { token, ...signer }, 'signBrokerFeeDisclosure');
