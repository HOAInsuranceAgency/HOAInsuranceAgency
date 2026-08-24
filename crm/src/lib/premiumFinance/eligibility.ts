import { coverageVerdict } from "./coverage";

/**
 * The eligibility screens, in one place.
 *
 * Pure and dependency-free beyond the coverage module, so the browser panel
 * and the origination Lambda evaluate the identical rules — the panel shows
 * what the server will decide, and the server decides it again anyway.
 *
 * Every unanswered question blocks. `producerOfRecord: null` is where
 * wholesale paper enters; an unknown auditable flag might be true. The
 * exemption does not have a benefit of the doubt.
 */

export interface EligibilityInputs {
  /** The anchor's lines — free text, screened against the signed lists. */
  lines: readonly (string | null | undefined)[];
  /** Account.type. */
  accountType: string | null | undefined;
  producerOfRecord: boolean | null | undefined;
  isAuditable: boolean | null | undefined;
  /**
   * The jurisdiction demands an incorporated borrower (Rhode Island,
   * § 19-14.1-10(b)(1)). When true, `incorporated` — Account.incorporated,
   * a recorded fact — must be explicitly true. Like producer-of-record:
   * no override, because the fix is to confirm the fact, not waive it.
   */
  requiresIncorporatedBorrower?: boolean;
  incorporated?: boolean | null | undefined;
  /** For the block message; the statute names the state, so we do too. */
  jurisdictionName?: string;
  /**
   * ADMIN overrides on file for this anchor. Auditable only: the MEP
   * screen — and its override — retired 2026-08-24, a signed decision
   * that the agency knowingly accepts early-default undersecurity on
   * high-MEP policies. MEP stays recorded as underwriting data.
   */
  overrides?: {
    auditable?: { reason: string };
  };
}

export interface EligibilityCheck {
  check: "coverage" | "producer-of-record" | "auditable" | "incorporated";
  ok: boolean;
  /**
   * True only for the personal-lines screen: no override exists, none may be
   * built, and the block message carries the retroactive-void warning.
   */
  hard: boolean;
  /** Present when an ADMIN override made a failing check pass. */
  overridden?: string;
  reason?: string;
}

export function evaluateEligibility(inputs: EligibilityInputs): EligibilityCheck[] {
  const checks: EligibilityCheck[] = [];

  // 1. Commercial lines only — the single most important rule in the module.
  const coverage = coverageVerdict(inputs.lines, inputs.accountType);
  checks.push(
    coverage.ok
      ? { check: "coverage", ok: true, hard: false }
      : { check: "coverage", ok: false, hard: coverage.hard, reason: coverage.reason }
  );

  // 2. Producer of record. Explicit true or nothing — no override, because
  // the fix is to confirm the fact, not to waive it.
  checks.push(
    inputs.producerOfRecord === true
      ? { check: "producer-of-record", ok: true, hard: false }
      : {
          check: "producer-of-record",
          ok: false,
          hard: false,
          reason:
            inputs.producerOfRecord === false
              ? "We are not the producer of record on this placement. No wholesale paper, no accommodation for another agency's client."
              : "Producer of record has not been confirmed. Confirm it on the policy or quote record — financing stays blocked until someone answers.",
        }
  );

  // 3. Auditable policies: the collateral can shrink at audit.
  const auditable = inputs.isAuditable;
  if (auditable === null || auditable === undefined) {
    checks.push({
      check: "auditable",
      ok: false,
      hard: false,
      reason:
        "Whether this coverage is auditable is not recorded. Answer it from the carrier's paper on the policy or quote record — financing stays blocked until someone does.",
    });
  } else if (auditable) {
    const reason =
      "This coverage is auditable: the earned premium can grow at audit, shrinking the unearned-premium collateral behind the loan.";
    const override = inputs.overrides?.auditable;
    checks.push(
      override?.reason
        ? { check: "auditable", ok: true, hard: false, overridden: override.reason, reason }
        : { check: "auditable", ok: false, hard: false, reason }
    );
  } else {
    checks.push({ check: "auditable", ok: true, hard: false });
  }

  // 4. Incorporated borrower — only where the signed row demands it (Rhode
  // Island). The screen exists only there, so the four screens stay four
  // everywhere else, and an unrecorded answer blocks exactly like an
  // unconfirmed producer of record: associations can be unincorporated,
  // and the statute does not take our word for it.
  if (inputs.requiresIncorporatedBorrower) {
    const name = inputs.jurisdictionName ?? "This jurisdiction";
    checks.push(
      inputs.incorporated === true
        ? { check: "incorporated", ok: true, hard: false }
        : {
            check: "incorporated",
            ok: false,
            hard: false,
            reason:
              inputs.incorporated === false
                ? `This association is recorded as unincorporated. ${name} lends to incorporated associations only — that is the statute's condition, not ours.`
                : `${name} lends to incorporated associations only, and whether this one is incorporated has not been recorded. Answer it from the association's articles — financing stays blocked until someone does.`,
          }
    );
  }

  return checks;
}

export const eligibilityBlocked = (checks: EligibilityCheck[]) =>
  checks.some((c) => !c.ok);
