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

const ACCEPT_MUTATION = `mutation AcceptFinanceElection($token: String!, $accept: Boolean!) {
  acceptFinanceElection(token: $token, accept: $accept)
}`;

/**
 * `a.json()` is AWSJSON on the wire, which is a JSON *string*, and the fetch
 * below does no parsing. Same trap `uploadPortal.ts` and `crmLead.ts`
 * document; it has cost a working panel twice already.
 */
function unwrap(raw: unknown): Record<string, unknown> | null {
  let v: unknown = raw;
  try {
    if (typeof v === "string") v = JSON.parse(v);
    if (typeof v === "string") v = JSON.parse(v);
  } catch {
    return null;
  }
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

async function call(
  query: string,
  variables: Record<string, unknown>,
  field: string
): Promise<Record<string, unknown>> {
  if (!API_URL || !API_KEY) {
    throw new Error("Financing is not configured on this build.");
  }
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`We couldn't reach the server (${res.status}).`);
  const body = await res.json();
  if (body.errors?.length) {
    throw new Error(body.errors[0].message ?? "The server refused that request.");
  }
  const result = unwrap(body.data?.[field]);
  if (!result) throw new Error("The server sent back something unreadable.");
  if (result.ok !== true) {
    throw new Error(String(result.error ?? "This financing link is no longer active."));
  }
  return result;
}

export interface ElectionTerms {
  state: "open" | "done" | "active" | "closed" | "checkout";
  reason: string | null;
  associationName: string;
  premium: number;
  months: number;
  apr: number;
  downPayment: number;
  amountFinanced: number;
  payment: number;
  totalInterest: number;
  originationFee: number;
  effectiveDate: string | null;
}

export async function fetchElectionTerms(token: string): Promise<ElectionTerms> {
  const r = await call(TERMS_QUERY, { token }, "financeElectionTerms");
  return {
    state: (r.state as ElectionTerms["state"]) ?? "closed",
    reason: typeof r.reason === "string" ? r.reason : null,
    associationName: String(r.associationName ?? "your association"),
    premium: Number(r.premium ?? 0),
    months: Number(r.months ?? 0),
    apr: Number(r.apr ?? 0),
    downPayment: Number(r.downPayment ?? 0),
    amountFinanced: Number(r.amountFinanced ?? 0),
    payment: Number(r.payment ?? 0),
    totalInterest: Number(r.totalInterest ?? 0),
    originationFee: Number(r.originationFee ?? 0),
    effectiveDate: typeof r.effectiveDate === "string" ? r.effectiveDate : null,
  };
}

/**
 * Accept, and come back with somewhere to go. `checkout` carries the Stripe
 * URL for the down payment + mandate; `done` means a stale second click on a
 * loan whose money already moved; `closed` explains itself in `reason`.
 */
export async function acceptElection(
  token: string
): Promise<{ state: string; url: string | null; reason: string | null }> {
  const r = await call(ACCEPT_MUTATION, { token, accept: true }, "acceptFinanceElection");
  return {
    state: String(r.state ?? "closed"),
    url: typeof r.url === "string" ? r.url : null,
    reason: typeof r.reason === "string" ? r.reason : null,
  };
}
