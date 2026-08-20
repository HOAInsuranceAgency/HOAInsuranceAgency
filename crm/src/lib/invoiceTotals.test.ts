import { describe, expect, it } from "vitest";
import {
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
  it("reports the commission rate back, for an invoice built from a policy", () => {
    for (const commissionPct of [10, 12.5, 15, 20]) {
      const line = premiumLineFromPolicy({ premium: 10000, commissionPct });
      expect(invoiceTotals([line]).marginPct, String(commissionPct)).toBe(
        commissionPct
      );
    }
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
  it("splits gross premium by the commission baked into it", () => {
    expect(premiumLineFromPolicy({ premium: 10000, commissionPct: 15 })).toEqual({
      retailAmount: 10000,
      costAmount: 8500,
    });
  });

  it("rounds the carrier's share to the cent", () => {
    const { costAmount } = premiumLineFromPolicy({
      premium: 12480.37,
      commissionPct: 12.5,
    });
    expect(costAmount).toBe(10920.32);
  });

  it("leaves cost empty rather than guessing, with no usable rate", () => {
    // An empty box asks to be filled. A confident wrong number does not.
    for (const commissionPct of [null, undefined, Number.NaN, -5, 100, 140]) {
      const line = premiumLineFromPolicy({ premium: 10000, commissionPct });
      expect(line.retailAmount, String(commissionPct)).toBe(10000);
      expect(line.costAmount, String(commissionPct)).toBeNull();
    }
  });

  it("returns nothing at all when the policy has no premium", () => {
    expect(premiumLineFromPolicy({ commissionPct: 15 })).toEqual({
      retailAmount: null,
      costAmount: null,
    });
  });

  it("treats a zero commission as real, not as missing", () => {
    // Some carriers pay nothing on a line. Cost equals retail, and that is a
    // fact worth recording rather than a blank to fill in.
    expect(premiumLineFromPolicy({ premium: 10000, commissionPct: 0 })).toEqual({
      retailAmount: 10000,
      costAmount: 10000,
    });
  });
});
