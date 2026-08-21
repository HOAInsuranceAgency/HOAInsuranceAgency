import { describe, expect, it } from "vitest";
import {
  directBillWarning,
  formatMoney,
  invoiceTotals,
  isPassThrough,
  marginWarnings,
  premiumLineFromPolicy,
} from "./invoiceTotals";

describe("invoiceTotals", () => {
  it("adds retail and cost, and calls the difference margin", () => {
    const t = invoiceTotals([
      { retailAmount: 10000, costAmount: 8500 },
      { retailAmount: 500, costAmount: 500 },
    ]);
    expect(t.retail).toBe(10500);
    expect(t.cost).toBe(9000);
    expect(t.margin).toBe(1500);
  });

  it("keeps floating point out of the total", () => {
    // 19.99 + 0.01 is famously not 20, and a fifty-line invoice compounds it.
    const t = invoiceTotals([
      { retailAmount: 19.99, costAmount: 0 },
      { retailAmount: 0.01, costAmount: 0 },
      { retailAmount: 0.1, costAmount: 0 },
      { retailAmount: 0.2, costAmount: 0 },
    ]);
    expect(t.retail).toBe(20.3);
    expect(String(t.retail)).not.toContain("0000");
  });

  it("treats missing amounts as zero rather than as NaN", () => {
    const t = invoiceTotals([
      { retailAmount: 100 },
      { retailAmount: null, costAmount: undefined },
      { retailAmount: Number.NaN, costAmount: Number.POSITIVE_INFINITY },
    ]);
    expect(t.retail).toBe(100);
    expect(t.cost).toBe(0);
    expect(Number.isFinite(t.margin)).toBe(true);
  });

  it("is zero across the board for an empty invoice", () => {
    expect(invoiceTotals([])).toEqual({
      retail: 0,
      cost: 0,
      margin: 0,
      marginPct: null,
    });
  });

  it("reports no margin percentage when nothing is billed", () => {
    // Null, not zero: "no margin" and "nothing billed" are different facts, and
    // a zero would render on screen as a real 0%.
    expect(invoiceTotals([{ retailAmount: 0, costAmount: 0 }]).marginPct).toBeNull();
    expect(invoiceTotals([{ retailAmount: 10000, costAmount: 8500 }]).marginPct).toBe(15);
  });

  /**
   * The reason margin is a share of retail rather than of cost.
   *
   * Commission is baked into the gross premium, so cost is `premium * (1 - pct)`
   * and margin is `premium * pct` — which makes margin over *retail* come back
   * as the commission rate itself. A producer reading 15% on an invoice built
   * from a 15% policy is reading the number they expect. Over cost it would say
   * 17.65% and mean nothing to anyone.
   */
  it("reports no margin on a line that is costed but not yet priced", () => {
    // What a seeded line is: the premium in the cost box, the amount blank.
    // Margin is negative and marginPct null, because there is no retail to be
    // a share of — the invoice is unfinished, not loss-making.
    const line = premiumLineFromPolicy({ premium: 10000 });
    const t = invoiceTotals([line]);
    expect(t.cost).toBe(10000);
    expect(t.retail).toBe(0);
    expect(t.marginPct).toBeNull();
  });

  it("handles a credit without inverting the arithmetic", () => {
    // A return premium endorsement bills negative and costs negative.
    const t = invoiceTotals([
      { retailAmount: 10000, costAmount: 8500 },
      { retailAmount: -1000, costAmount: -850 },
    ]);
    expect(t.retail).toBe(9000);
    expect(t.cost).toBe(7650);
    expect(t.margin).toBe(1350);
  });
});

describe("marginWarnings", () => {
  it("says nothing about an ordinary premium line", () => {
    expect(
      marginWarnings([{ kind: "PREMIUM", retailAmount: 10000, costAmount: 8500 }])
    ).toEqual([]);
  });

  it("does not flag a pass-through for having no margin", () => {
    // Zero margin on a tax is correct, not an omission.
    for (const kind of ["TAX", "SURPLUS_LINES", "STAMPING_FEE"]) {
      expect(
        marginWarnings([{ kind, retailAmount: 400, costAmount: 400 }]),
        kind
      ).toEqual([]);
      expect(isPassThrough(kind)).toBe(true);
    }
    expect(isPassThrough("PREMIUM")).toBe(false);
    expect(isPassThrough(null)).toBe(false);
  });

  it("flags a pass-through that is not passing through", () => {
    const w = marginWarnings([{ kind: "TAX", retailAmount: 450, costAmount: 400 }]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/pass-through/);
  });

  it("flags a line that costs more than it bills", () => {
    const w = marginWarnings([
      { kind: "PREMIUM", retailAmount: 8000, costAmount: 8500 },
    ]);
    expect(w[0]).toMatch(/costs more than it bills/);
  });

  it("flags a line with no cost, which reads as all margin", () => {
    const w = marginWarnings([{ kind: "PREMIUM", retailAmount: 10000 }]);
    expect(w[0]).toMatch(/no cost recorded/);
  });

  it("flags a negative amount, and says nothing else about that line", () => {
    const w = marginWarnings([{ kind: "PREMIUM", retailAmount: -5, costAmount: 10 }]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/negative/);
  });

  it("ignores a blank line someone has not filled in yet", () => {
    expect(marginWarnings([{ kind: "PREMIUM" }])).toEqual([]);
  });

  it("numbers the lines the way a person reads them, from one", () => {
    const w = marginWarnings([
      { kind: "PREMIUM", retailAmount: 100, costAmount: 90 },
      { kind: "PREMIUM", retailAmount: 100 },
    ]);
    expect(w[0]).toMatch(/^Line 2/);
  });
});

describe("formatMoney", () => {
  it("formats US dollars to the cent", () => {
    expect(formatMoney(12480.5)).toBe("$12,480.50");
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(-1000)).toBe("-$1,000.00");
  });

  it("does not depend on the runtime's locale", () => {
    // A Lambda runs in UTC with no locale of its own. An invoice rendering as
    // "12 480,01 €" because Node guessed is not a bug anyone finds quickly.
    expect(formatMoney(12480.01)).toContain("$");
    expect(formatMoney(12480.01)).not.toContain("€");
  });

  it("renders a missing amount as zero rather than as NaN", () => {
    expect(formatMoney(null)).toBe("$0.00");
    expect(formatMoney(undefined)).toBe("$0.00");
    expect(formatMoney(Number.NaN)).toBe("$0.00");
  });
});

describe("premiumLineFromPolicy", () => {
  it("puts the premium in the cost box and leaves the amount blank", () => {
    expect(premiumLineFromPolicy({ premium: 10000 })).toEqual({
      retailAmount: null,
      costAmount: 10000,
    });
  });

  it("does not derive anything from the commission rate", () => {
    // It used to, and the derived figure was a guess presented as a fact: a
    // carrier applies different rates per line, and the remittance is what the
    // statement says. Passing a rate must change nothing.
    for (const commissionPct of [0, 12.5, 15, null, undefined, Number.NaN, -5, 140]) {
      expect(
        premiumLineFromPolicy({ premium: 10000, commissionPct } as never),
        String(commissionPct)
      ).toEqual({ retailAmount: null, costAmount: 10000 });
    }
  });

  it("rounds the premium to the cent", () => {
    expect(premiumLineFromPolicy({ premium: 12480.005 }).costAmount).toBe(12480.01);
  });

  it("returns nothing at all when the policy has no premium", () => {
    expect(premiumLineFromPolicy({})).toEqual({
      retailAmount: null,
      costAmount: null,
    });
    for (const premium of [null, undefined, Number.NaN, Infinity]) {
      expect(premiumLineFromPolicy({ premium }).costAmount, String(premium)).toBeNull();
    }
  });
});

/**
 * Billing premium the carrier is already collecting.
 *
 * The error this catches has no other detector: every line on such an invoice
 * is individually well-formed, the margins are right, the total adds up — and
 * the association receives a bill for money it is paying someone else. Only
 * the policy's bill type makes it visible.
 */
describe("directBillWarning", () => {
  const premium = { kind: "PREMIUM", retailAmount: 12480, costAmount: 10608 };
  const fee = { kind: "OTHER", retailAmount: 250, costAmount: 0 };
  const tax = { kind: "SURPLUS_LINES", retailAmount: 499, costAmount: 499 };

  it("fires on premium billed against a direct-bill policy", () => {
    const w = directBillWarning("DIRECT", [premium]);
    expect(w).toContain("direct bill");
    expect(w).toContain("One line bills");
  });

  it("counts the lines, in words that agree with the number", () => {
    expect(directBillWarning("DIRECT", [premium, premium])).toContain(
      "2 lines bill"
    );
    expect(directBillWarning("DIRECT", [premium])).toContain("One line bills");
  });

  it("treats endorsement premium the same way", () => {
    // Also the carrier's money on a direct-bill placement.
    expect(directBillWarning("DIRECT", [{ kind: "ENDORSEMENT" }])).toBeTruthy();
  });

  it("says nothing about an agency-bill policy", () => {
    expect(directBillWarning("AGENCY", [premium])).toBeNull();
  });

  it("says nothing when the bill type was never recorded", () => {
    // Policies bound before the field existed have no answer, and guessing
    // "direct" would put a warning on every one of them.
    expect(directBillWarning(null, [premium])).toBeNull();
    expect(directBillWarning(undefined, [premium])).toBeNull();
    expect(directBillWarning("", [premium])).toBeNull();
  });

  it("leaves an agency fee on a direct-bill policy alone", () => {
    // The legitimate case, and the reason this warns rather than blocks: a
    // broker fee is the agency's own charge whoever bills the premium.
    expect(directBillWarning("DIRECT", [fee])).toBeNull();
  });

  it("leaves surplus lines tax alone", () => {
    // On a surplus placement the agency is often broker of record for the tax
    // and stamping fee and does collect them, whoever bills the premium —
    // flagging those would be wrong exactly where they most often appear.
    expect(directBillWarning("DIRECT", [tax])).toBeNull();
    expect(directBillWarning("DIRECT", [{ kind: "TAX" }])).toBeNull();
    expect(directBillWarning("DIRECT", [{ kind: "STAMPING_FEE" }])).toBeNull();
  });

  it("fires on the premium even when fees are mixed in", () => {
    expect(directBillWarning("DIRECT", [fee, premium, tax])).toContain(
      "One line bills"
    );
  });

  it("says nothing about an empty invoice", () => {
    expect(directBillWarning("DIRECT", [])).toBeNull();
  });

  it("does not depend on the amounts", () => {
    // A premium line with nothing filled in yet is still a premium line, and
    // the point is to say so before the number is typed.
    expect(directBillWarning("DIRECT", [{ kind: "PREMIUM" }])).toBeTruthy();
  });
});
