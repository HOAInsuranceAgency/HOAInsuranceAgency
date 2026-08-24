import { coverageVerdict } from "./coverage";

/**
 * The four eligibility screens on a policy, in one place.
 *
 * Pure and dependency-free beyond the coverage module, so the browser panel
 * and the origination Lambda evaluate the identical rules — the panel shows
 * what the server will decide, and the server decides it again anyway.
 *
 * Every unanswered question blocks. `producerOfRecord: null` is where
 * wholesale paper enters; an unrecorded MEP might be 25%; an unknown
 * auditable flag might be true. The exemption does not have a benefit of the
 * doubt.
 */

export interface EligibilityInputs {
  /** Policy.lines — free text, screened against the signed lists. */
  lines: readonly (string | null | undefined)[];
  /** Account.type. */
  accountType: string | null | undefined;
  producerOfRecord: boolean | null | undefined;
  minimumEarnedPremiumPct: number | null | undefined;
  isAuditable: boolean | null | undefined;
  /** The quote's down payment percent — MEP is measured against it. */
  downPct: number;
  /** ADMIN overrides on file for this policy, keyed by check. */
  overrides?: {
    mep?: { reason: string };
    auditable?: { reason: string };
  };
}

export interface EligibilityCheck {
  check: "coverage" | "producer-of-record" | "mep" | "auditable";
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
              ? "We are not the producer of record on this policy. No wholesale paper, no accommodation for another agency's client."
              : "Producer of record has not been confirmed on this policy. Confirm it on the policy record — financing stays blocked until someone answers.",
        }
  );

  // 3. Minimum earned premium vs the down payment.
  const mep = inputs.minimumEarnedPremiumPct;
  if (mep === null || mep === undefined) {
    checks.push({
      check: "mep",
      ok: false,
      hard: false,
      reason:
        "Minimum earned premium is not recorded on this policy. Enter it from the policy PDF — zero is an answer; blank is not.",
    });
  } else if (mep >= inputs.downPct) {
    const reason = `${mep}% MEP against a ${inputs.downPct}% down payment leaves no collateral cushion at inception.`;
    const override = inputs.overrides?.mep;
    checks.push(
      override?.reason
        ? { check: "mep", ok: true, hard: false, overridden: override.reason, reason }
        : { check: "mep", ok: false, hard: false, reason }
    );
  } else {
    checks.push({ check: "mep", ok: true, hard: false });
  }

  // 4. Auditable policies: the collateral can shrink at audit.
  const auditable = inputs.isAuditable;
  if (auditable === null || auditable === undefined) {
    checks.push({
      check: "auditable",
      ok: false,
      hard: false,
      reason:
        "Whether this policy is auditable is not recorded. Answer it from the policy PDF — financing stays blocked until someone does.",
    });
  } else if (auditable) {
    const reason =
      "This policy is auditable: the earned premium can grow at audit, shrinking the unearned-premium collateral behind the loan.";
    const override = inputs.overrides?.auditable;
    checks.push(
      override?.reason
        ? { check: "auditable", ok: true, hard: false, overridden: override.reason, reason }
        : { check: "auditable", ok: false, hard: false, reason }
    );
  } else {
    checks.push({ check: "auditable", ok: true, hard: false });
  }

  return checks;
}

export const eligibilityBlocked = (checks: EligibilityCheck[]) =>
  checks.some((c) => !c.ok);
