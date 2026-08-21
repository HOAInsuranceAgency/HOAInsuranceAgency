import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addMonthsClamped,
  buildQuote,
  payoffAfterPayment,
  PF_DEFAULT_APR,
  PF_DEFAULT_DOWN_PCT,
  PF_DEFAULT_MONTHS,
  PF_ORIGINATION_FEE,
} from "./quote";

/** The signed reference case: $1M premium, 25% down, 9 months. */
const base = {
  premium: 1_000_000,
  downPct: 25,
  months: 9,
  apr: 14.0,
  effectiveDate: "2026-09-01",
};

describe("the signed test vectors", () => {
  it("14.0% — financed $750,000, interest $44,426, payment $88,269.61", () => {
    const q = buildQuote(base);
    expect(q.amountFinanced).toBe(750_000);
    expect(q.downPayment).toBe(250_000);
    expect(Math.round(q.totalInterest)).toBe(44_426);
    // The exact figure, to the cent — the schedule's rounding telescopes to it.
    expect(q.totalInterest).toBe(44_426.49);
    expect(q.payment).toBe(88_269.61);
  });

  it("18.0% — interest $57,366", () => {
    const q = buildQuote({ ...base, apr: 18.0 });
    expect(Math.round(q.totalInterest)).toBe(57_366);
    expect(q.totalInterest).toBe(57_366.31);
  });

  it("14.0% — average outstanding $317,332, under the pinned convention", () => {
    // Mean of the twelve monthly OPENING balances across a 12-month policy
    // year, months 10–12 at zero. Confirmed as the intended convention
    // 2026-08-21. Closing balances give a different figure; so does a 9-month
    // window. If this test starts failing after a refactor, the refactor
    // changed the convention — put it back.
    const q = buildQuote(base);
    expect(Math.round(q.averageOutstanding12Mo)).toBe(317_332);
  });
});

describe("the schedule adds up to itself", () => {
  it("principal sums to the amount financed, payments to principal + interest", () => {
    for (const apr of [9.9, 14.0, 18.0, 24.0]) {
      const q = buildQuote({ ...base, apr });
      const principal = q.schedule.reduce((s, r) => s + r.principal, 0);
      const interest = q.schedule.reduce((s, r) => s + r.interest, 0);
      expect(Math.round(principal * 100) / 100, String(apr)).toBe(q.amountFinanced);
      expect(Math.round((principal + interest) * 100) / 100, String(apr)).toBe(
        q.totalOfPayments
      );
      expect(q.schedule[q.schedule.length - 1].balance, String(apr)).toBe(0);
    }
  });

  it("every row's payment covers its own interest", () => {
    const q = buildQuote(base);
    for (const row of q.schedule) {
      expect(row.payment).toBeGreaterThan(row.interest);
      expect(row.principal).toBeGreaterThan(0);
    }
  });

  it("due dates run monthly from the effective date, clamped at month ends", () => {
    const q = buildQuote({ ...base, effectiveDate: "2026-01-31" });
    expect(q.schedule[0].dueDate).toBe("2026-02-28");
    expect(q.schedule[1].dueDate).toBe("2026-03-31");
    expect(addMonthsClamped("2028-01-31", 1)).toBe("2028-02-29"); // leap year
    expect(addMonthsClamped("2026-11-15", 2)).toBe("2027-01-15"); // year roll
  });
});

describe("defaults and the fee", () => {
  it("25% down, 9 months, 14.0% APR — never a jurisdiction cap", () => {
    expect(PF_DEFAULT_DOWN_PCT).toBe(25);
    expect(PF_DEFAULT_MONTHS).toBe(9);
    expect(PF_DEFAULT_APR).toBe(14.0);
  });

  it("charges a flat $10 origination fee, refundable on prepayment", () => {
    expect(PF_ORIGINATION_FEE).toBe(10.0);
    const q = buildQuote(base);
    expect(q.originationFee).toBe(10.0);
    expect(payoffAfterPayment(q, 3).originationFeeRefund).toBe(10.0);
  });
});

describe("prepayment — actuarial method", () => {
  it("payoff is the outstanding principal, nothing more", () => {
    const q = buildQuote(base);
    const p = payoffAfterPayment(q, 4);
    expect(p.payoffAmount).toBe(q.schedule[3].balance);
  });

  it("earned plus unearned interest is the whole schedule, at every point", () => {
    const q = buildQuote(base);
    for (let k = 0; k <= 9; k++) {
      const earned = q.schedule.slice(0, k).reduce((s, r) => s + r.interest, 0);
      const p = payoffAfterPayment(q, k);
      expect(Math.round((earned + p.unearnedInterest) * 100) / 100, `k=${k}`).toBe(
        q.totalInterest
      );
    }
  });

  it("a loan paid to term has nothing left to refund but the fee", () => {
    const q = buildQuote(base);
    const p = payoffAfterPayment(q, 9);
    expect(p.payoffAmount).toBe(0);
    expect(p.unearnedInterest).toBe(0);
  });

  it("refuses a payment number the schedule does not have", () => {
    const q = buildQuote(base);
    expect(() => payoffAfterPayment(q, 10)).toThrow();
    expect(() => payoffAfterPayment(q, -1)).toThrow();
  });
});

/**
 * What must not exist, asserted against the source.
 *
 * The Rule of 78s must appear nowhere; late/delinquency/reinstatement charges
 * have no fields to fill. These are grep tests because the failure mode is a
 * future convenience — a column added "for later" is how per-state regulated
 * charges get invented ad hoc.
 */
describe("what the module must never contain", () => {
  const dir = resolve(process.cwd(), "src/lib/premiumFinance");
  const sources = readdirSync(dir).filter(
    // Hand-written sources only: the generated module's SHA hex can contain
    // any digit pair, and the signed YAML notes are not code.
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "jurisdictions.ts"
  );

  it("covers the modules this suite thinks it covers", () => {
    expect(sources.sort()).toEqual([
      "coverage.ts",
      "eligibility.ts",
      "gate.ts",
      "noticeSequence.ts",
      "quote.ts",
    ]);
  });

  // The comments are allowed to NAME the forbidden method — that is how the
  // prohibition is explained to the next reader — so only code is grepped.
  const codeOf = (f: string) =>
    readFileSync(resolve(dir, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

  it("no Rule of 78s, by any name", () => {
    for (const f of sources) {
      const code = codeOf(f);
      expect(code, f).not.toMatch(/78/);
      expect(code.toLowerCase(), f).not.toMatch(/sum.?of.?digits|precomputed/);
    }
  });

  it("no late, delinquency, or reinstatement anything", () => {
    for (const f of sources) {
      const code = codeOf(f).toLowerCase().replace(/\s+/g, "");
      for (const banned of ["latefee", "late_fee", "delinquen", "reinstat"]) {
        expect(code, `${f}: ${banned}`).not.toContain(banned);
      }
    }
  });
});
