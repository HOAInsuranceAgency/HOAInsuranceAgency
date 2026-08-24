import { coverageVerdict } from "./coverage";

/**
 * The eligibility screens, in one place.
 *
 * Pure and dependency-free beyond the coverage module, so the browser panel
 * and the origination Lambda evaluate the identical rules — the panel shows
 * what the server will decide, and the server decides it again anyway.
 *
 * Three screens retired by signed decision, all 2026-08-24: MEP (the agency
 * knowingly accepts early-default undersecurity on high-MEP policies),
 * auditable ("everything we do is final once entered" — this book's
 * premiums do not move at audit), and producer-of-record ("we are always
 * the producer of record" — the agency writes no wholesale paper, so the
 * screen only ever blocked its own deals on an unticked box). What remains
 * is what the exemptions actually stand on: commercial lines only, and
 * Rhode Island's incorporated-borrower condition. No override exists for
 * either, and none may be built.
 */

export interface EligibilityInputs {
  /** The anchor's lines — free text, screened against the signed lists. */
  lines: readonly (string | null | undefined)[];
  /** Account.type. */
  accountType: string | null | undefined;
  /**
   * The jurisdiction demands an incorporated borrower (Rhode Island,
   * § 19-14.1-10(b)(1)). When true, `incorporated` — Account.incorporated,
   * a recorded fact — must be explicitly true. No override, because the
   * fix is to confirm the fact, not waive it.
   */
  requiresIncorporatedBorrower?: boolean;
  incorporated?: boolean | null | undefined;
  /** For the block message; the statute names the state, so we do too. */
  jurisdictionName?: string;
}

export interface EligibilityCheck {
  check: "coverage" | "incorporated";
  ok: boolean;
  /**
   * True only for the personal-lines screen: no override exists, none may be
   * built, and the block message carries the retroactive-void warning.
   */
  hard: boolean;
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

  // 2. Incorporated borrower — only where the signed row demands it (Rhode
  // Island). The screen exists only there, so one screen stays one
  // everywhere else, and an unrecorded answer blocks: associations can be
  // unincorporated, and the statute does not take our word for it.
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
