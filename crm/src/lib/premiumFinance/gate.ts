import {
  PF_JURISDICTIONS,
  type PfJurisdiction,
} from "./jurisdictions";

/**
 * The jurisdiction gate: may this agency originate a premium finance loan in
 * this state, today?
 *
 * ── This is an ORIGINATION gate and nothing else ────────────────────────────
 * It answers one question, asked once, at the moment a quote or agreement is
 * about to come into being. It must never be consulted from payment posting,
 * the notice sequence, or payoff: a jurisdiction closing in the signed YAML
 * stops NEW lending there and cannot touch loans that already exist, because
 * the money is already out the door — we cannot un-lend. A test asserts the
 * servicing paths never import this module.
 *
 * ── Physical address state, only ────────────────────────────────────────────
 * The input is `Account.state` — the association's physical premises, the same
 * field the ACORD forms use. An association's MAILING address is usually its
 * management company's, often in another state, and must never be substituted
 * here even if a mailing-address field is added to the Account someday. A
 * source-assertion test holds this module to reading nothing but a state
 * string.
 *
 * ── Fail closed ─────────────────────────────────────────────────────────────
 * Everything unrecognized or unresolved is a block: an unknown state, a
 * missing state, a ceiling nobody has verified (`maxAprVerified: false` — the
 * Arkansas/Rhode Island rows ship that way deliberately), a conditional
 * jurisdiction without a current counsel opinion. Lending where we should not
 * is a licensing violation; refusing where we could is a lost sale. Those are
 * not symmetric.
 *
 * Dependency-free (data import aside), like invoiceTotals.ts, so the browser
 * and the issuance Lambda run the identical gate.
 */

/** Uppercase code and lowercase name lookups, built once. */
const BY_CODE = new Map<string, PfJurisdiction>();
const BY_NAME = new Map<string, PfJurisdiction>();
for (const j of PF_JURISDICTIONS) {
  BY_CODE.set(j.code, j);
  BY_NAME.set(j.name.toLowerCase(), j);
}

/**
 * Resolve a state as the Account model may hold it: a USPS code ("MA"), a full
 * name ("Massachusetts"), any casing, stray whitespace. Null for anything
 * else — which the gate then treats as closed.
 */
export function jurisdictionFor(
  state: string | null | undefined
): PfJurisdiction | null {
  const raw = (state ?? "").trim();
  if (!raw) return null;
  return BY_CODE.get(raw.toUpperCase()) ?? BY_NAME.get(raw.toLowerCase()) ?? null;
}

export type GateDecision =
  | { open: true; jurisdiction: PfJurisdiction }
  | { open: false; jurisdiction: PfJurisdiction | null; reason: string };

/**
 * What the caller must already know for a `conditional` jurisdiction to open.
 * The opinion store is W6; until a current opinion exists for the state,
 * conditional is a block that says what is missing.
 */
export interface GateContext {
  /** A signed counsel opinion for this jurisdiction, within its review date. */
  hasCurrentCounselOpinion?: boolean;
}

export function originationGate(
  state: string | null | undefined,
  ctx: GateContext = {}
): GateDecision {
  const j = jurisdictionFor(state);
  if (!j) {
    return {
      open: false,
      jurisdiction: null,
      reason: `"${(state ?? "").trim() || "no state on the account"}" is not a recognized U.S. jurisdiction. Financing is unavailable until the account's state is set.`,
    };
  }
  if (j.status === "closed") {
    return { open: false, jurisdiction: j, reason: j.note };
  }
  /**
   * Before the status check on purpose: an unverified ceiling closes the
   * jurisdiction whatever its status says. Charging any rate against a cap
   * nobody has read is the exact risk the flag encodes.
   */
  if (!j.maxAprVerified) {
    return {
      open: false,
      jurisdiction: j,
      reason: `Rate ceiling unverified — treated as closed. ${j.note}`,
    };
  }
  if (j.status === "conditional" && !ctx.hasCurrentCounselOpinion) {
    return {
      open: false,
      jurisdiction: j,
      reason: `Needs a current counsel opinion on file before any origination. ${j.note}`,
    };
  }
  return { open: true, jurisdiction: j };
}

/**
 * Server-side APR validation for quote issuance. Null = acceptable.
 *
 * The cap is a ceiling, not a target: nothing anywhere defaults an APR to it,
 * and the UI never shows it as a suggestion — it appears only here, in the
 * rejection. (Decision E: pricing to the statutory maximum in every state is
 * how multi-state lenders get caught.)
 */
export function aprCapViolation(
  apr: number,
  j: PfJurisdiction
): string | null {
  if (!Number.isFinite(apr) || apr <= 0) return "APR must be a positive number.";
  if (j.maxApr !== null && j.maxAprVerified && apr > j.maxApr) {
    return `${apr}% exceeds the ${j.name} maximum of ${j.maxApr}%.`;
  }
  return null;
}

/** Minimum-principal validation, measured against AMOUNT FINANCED (decision 7). */
export function minPrincipalViolation(
  amountFinanced: number,
  j: PfJurisdiction
): string | null {
  if (j.minPrincipal !== null && amountFinanced < j.minPrincipal) {
    return `${j.name} permits financing only above $${j.minPrincipal.toLocaleString("en-US")} of principal; this quote finances $${Math.round(amountFinanced).toLocaleString("en-US")}.`;
  }
  return null;
}
