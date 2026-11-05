import { publicApi } from "./publicApi";
import { isFinanceElectionTerms, isFinanceElectionAcceptance } from '../../../shared/financeElection';
/**
 * The finance election's two calls against the CRM's public AppSync API.
 *
 * Sibling of `uploadPortal.ts`, configured by the same two env vars, and it
 * surfaces failure the same way: the election IS the page, and a board
 * treasurer silently failing to accept financing would believe they had.
 */

const API_URL = import.meta.env.PUBLIC_CRM_API_URL;
const API_KEY = import.meta.env.PUBLIC_CRM_API_KEY;

const TERMS_QUERY = `query FinanceElectionTerms($token: String!) {
  financeElectionTerms(token: $token)
}`;

const ACCEPT_MUTATION = `mutation AcceptFinanceElection($token: String!, $accept: Boolean!, $signerName: String, $signerRole: String) {
  acceptFinanceElection(token: $token, accept: $accept, signerName: $signerName, signerRole: $signerRole)
}`;

async function call(query: string, variables: Record<string, unknown>, field: string) {
  return publicApi(query, variables, field, {
    url: API_URL, key: API_KEY, configurationError: 'Financing is not configured on this build.',
    refused: 'This financing link is no longer active.',
  });
}

export interface ElectionTerms {
  state: "open" | "done" | "active" | "closed";
  reason: string | null;
  associationName: string;
  premium: number;
  months: number;
  apr: number;
  downPayment: number;
  initialPaymentAmount: number;
  amountFinanced: number;
  payment: number;
  totalInterest: number;
  originationFee: number;
  brokerFee: number;
  effectiveDate: string | null;
  /** The agreement paragraphs the customer signs — served, never copied. */
  agreementTerms: string[];
  /** Set when a revived link is already signed; the page then skips the ask. */
  agreementSignedName: string | null;
  agreementSignedRole: string | null;
}

export async function fetchElectionTerms(token: string): Promise<ElectionTerms> {
  const r = await call(TERMS_QUERY, { token }, "financeElectionTerms");
  if (!isFinanceElectionTerms(r)) throw new Error('The server sent back something unreadable.');
  if (r.state === 'closed') return { state: 'closed', reason: r.reason ?? null, associationName: 'your association', premium: 0, months: 0, apr: 0, downPayment: 0, initialPaymentAmount: 0, amountFinanced: 0, payment: 0, totalInterest: 0, originationFee: 0, brokerFee: 0, effectiveDate: null, agreementTerms: [], agreementSignedName: null, agreementSignedRole: null };
  return {
    state: r.state,
    reason: null,
    associationName: String(r.associationName ?? "your association"),
    premium: Number(r.premium ?? 0),
    months: Number(r.months ?? 0),
    apr: Number(r.apr ?? 0),
    downPayment: Number(r.downPayment ?? 0),
    initialPaymentAmount: Number(r.initialPaymentAmount ?? (Number(r.downPayment ?? 0) + Number(r.originationFee ?? 0) + Number(r.brokerFee ?? 0))),
    amountFinanced: Number(r.amountFinanced ?? 0),
    payment: Number(r.payment ?? 0),
    totalInterest: Number(r.totalInterest ?? 0),
    originationFee: Number(r.originationFee ?? 0),
    brokerFee: Number(r.brokerFee ?? 0),
    effectiveDate: typeof r.effectiveDate === "string" ? r.effectiveDate : null,
    agreementTerms: Array.isArray(r.agreementTerms)
      ? r.agreementTerms.filter((p): p is string => typeof p === "string")
      : [],
    agreementSignedName:
      typeof r.agreementSignedName === "string" ? r.agreementSignedName : null,
    agreementSignedRole:
      typeof r.agreementSignedRole === "string" ? r.agreementSignedRole : null,
  };
}

/**
 * Accept, and come back with somewhere to go. `checkout` carries the Stripe
 * URL for the down payment + mandate; `done` means a stale second click on a
 * loan whose money already moved; `closed` explains itself in `reason`.
 */
export async function acceptElection(
  token: string,
  signer?: { name: string; role: string }
): Promise<{ state: 'checkout' | 'done' | 'closed'; url: string | null; reason: string | null }> {
  const r = await call(
    ACCEPT_MUTATION,
    {
      token,
      accept: true,
      signerName: signer?.name ?? null,
      signerRole: signer?.role ?? null,
    },
    "acceptFinanceElection"
  );
  if (!isFinanceElectionAcceptance(r)) throw new Error('The server sent back something unreadable.');
  return { state: r.state, url: r.state === 'checkout' ? r.url : null, reason: r.state === 'closed' ? r.reason ?? null : null };
}
