import { describe, expect, it } from "vitest";
import {
  buildProgress,
  type ProgressInputs,
} from "../../amplify/functions/ops-rollup/progress";

/**
 * The business figures.
 *
 * `done.ts` counts what was typed; this says whether the agency is winning.
 * The number that matters most here is the comparison — a month-to-date total
 * with nothing beside it is a fact nobody can act on, and the classic way to
 * invent a collapse is to compare a partial month against a whole one.
 */

const TODAY = "2026-08-25"; // Tuesday
const WINDOW_START = "2026-08-24"; // Monday

const EMPTY: ProgressInputs = { policies: [], quotes: [], accounts: [], carriers: [] };
const inputs = (over: Partial<ProgressInputs> = {}): ProgressInputs => ({ ...EMPTY, ...over });

const ACCOUNTS = [
  { id: "a1", name: "Maple Ridge Condominium", stage: "CLIENT" },
  { id: "a2", name: "Harbour Point", stage: "CLIENT" },
  { id: "a3", name: "Willow Bend", stage: "LEAD" },
];

describe("won and lost", () => {
  it("names what bound in the window, with the carrier", () => {
    const p = buildProgress(
      inputs({
        accounts: ACCOUNTS,
        carriers: [{ id: "c1", name: "Travelers" }],
        policies: [
          {
            accountId: "a1",
            status: "ACTIVE",
            premium: 41200,
            carrierId: "c1",
            datePolicyBound: "2026-08-24T18:00:00Z",
          },
        ],
      }),
      TODAY,
      WINDOW_START
    );
    expect(p.won).toEqual([
      { account: "Maple Ridge Condominium", premium: 41200, detail: "Travelers" },
    ]);
  });

  /**
   * Quote stores no decision date, so "lost" is really "the row was last
   * written in the window". The wording in the email says "marked" for that
   * reason, and the detail distinguishes a carrier declining from a deal lost.
   */
  it("reports what was marked declined or lost, and which", () => {
    const p = buildProgress(
      inputs({
        accounts: ACCOUNTS,
        quotes: [
          { accountId: "a2", status: "DECLINED", premium: 18000, updatedAt: "2026-08-24T12:00:00Z" },
          { accountId: "a3", status: "LOST", premium: 9000, updatedAt: "2026-08-24T12:00:00Z" },
          { accountId: "a1", status: "LOST", premium: 1, updatedAt: "2026-08-20T12:00:00Z" },
        ],
      }),
      TODAY,
      WINDOW_START
    );
    expect(p.lost).toEqual([
      { account: "Harbour Point", premium: 18000, detail: "carrier declined" },
      { account: "Willow Bend", premium: 9000, detail: "lost" },
    ]);
  });

  it("reports no outcomes at all on a weekend edition", () => {
    const p = buildProgress(
      inputs({
        accounts: ACCOUNTS,
        policies: [{ accountId: "a1", premium: 1, datePolicyBound: "2026-08-24T18:00:00Z" }],
      }),
      TODAY,
      null
    );
    expect(p.won).toEqual([]);
    expect(p.lost).toEqual([]);
  });
});

describe("pace", () => {
  const policies = [
    // This month, through yesterday.
    { accountId: "a1", premium: 40000, commissionPct: 10, datePolicyBound: "2026-08-05T12:00:00Z" },
    { accountId: "a1", premium: 20000, commissionPct: 10, datePolicyBound: "2026-08-24T12:00:00Z" },
    // Today — excluded, the window never covers today.
    { accountId: "a1", premium: 999_999, datePolicyBound: "2026-08-25T12:00:00Z" },
    // Same span last month (1st–24th July).
    { accountId: "a2", premium: 50000, datePolicyBound: "2026-07-10T12:00:00Z" },
    // Later in July, past the 24th — outside the comparable span.
    { accountId: "a2", premium: 900_000, datePolicyBound: "2026-07-29T12:00:00Z" },
  ];

  it("totals the month to date, excluding today", () => {
    const p = buildProgress(inputs({ accounts: ACCOUNTS, policies }), TODAY, WINDOW_START);
    expect(p.mtdPremium).toBe(60000);
    expect(p.mtdPolicies).toBe(2);
    expect(p.mtdCommission).toBe(6000);
  });

  /**
   * Comparing 24 days against a full 31 would report a healthy month as a
   * collapse every time, and the error grows as the month goes on.
   */
  it("compares against the same span of the previous month, not the whole of it", () => {
    const p = buildProgress(inputs({ accounts: ACCOUNTS, policies }), TODAY, WINDOW_START);
    expect(p.priorPremium).toBe(50000);
    expect(p.pacePct).toBeCloseTo(0.2);
  });

  it("declines to state a pace when there is nothing to compare against", () => {
    const p = buildProgress(
      inputs({
        accounts: ACCOUNTS,
        policies: [{ accountId: "a1", premium: 40000, datePolicyBound: "2026-08-05T12:00:00Z" }],
      }),
      TODAY,
      WINDOW_START
    );
    expect(p.priorPremium).toBe(0);
    expect(p.pacePct).toBe(null);
  });

  it("counts bound policies whose commission percentage is missing", () => {
    const p = buildProgress(
      inputs({
        accounts: ACCOUNTS,
        policies: [{ accountId: "a1", premium: 40000, datePolicyBound: "2026-08-05T12:00:00Z" }],
      }),
      TODAY,
      WINDOW_START
    );
    expect(p.mtdWithoutCommission).toBe(1);
    expect(p.mtdCommission).toBe(0);
  });

  it("handles the turn of the year when looking back a month", () => {
    const p = buildProgress(
      inputs({
        accounts: ACCOUNTS,
        policies: [
          { accountId: "a1", premium: 5000, datePolicyBound: "2025-12-05T12:00:00Z" },
        ],
      }),
      "2026-01-15",
      "2026-01-14"
    );
    expect(p.priorPremium).toBe(5000);
  });
});

describe("pipeline", () => {
  const quotes = [
    { accountId: "a1", status: "SUBMITTED", premium: 30000, effectiveDate: "2026-09-01" },
    { accountId: "a2", status: "QUOTED", premium: 20000, effectiveDate: "2026-11-01" },
    { accountId: "a3", status: "PRESENTED", premium: 10000 },
    { accountId: "a1", status: "DRAFT", premium: 999 },
    { accountId: "a1", status: "BOUND", premium: 999 },
  ];

  it("values what is in flight by stage, excluding drafts and decided quotes", () => {
    const p = buildProgress(inputs({ accounts: ACCOUNTS, quotes }), TODAY, WINDOW_START);
    expect(p.pipelineTotal).toBe(60000);
    expect(p.pipelineCount).toBe(3);
    expect(p.pipeline.map((s) => s.stage)).toEqual(["SUBMITTED", "QUOTED", "PRESENTED"]);
  });

  it("counts only the decisions whose effective date is actually near", () => {
    const p = buildProgress(inputs({ accounts: ACCOUNTS, quotes }), TODAY, WINDOW_START);
    expect(p.decisionsDue.count).toBe(1);
    expect(p.decisionsDue.premium).toBe(30000);
  });
});

describe("the book", () => {
  it("counts what the agency currently holds", () => {
    const p = buildProgress(
      inputs({
        accounts: ACCOUNTS,
        policies: [
          { accountId: "a1", status: "ACTIVE" },
          { accountId: "a2", status: "CANCELLED" },
        ],
        quotes: [
          { accountId: "a1", status: "BOUND" },
          { accountId: "a2", status: "LOST" },
        ],
      }),
      TODAY,
      WINDOW_START
    );
    expect(p.activePolicies).toBe(1);
    expect(p.clients).toBe(2);
    expect(p.leads).toBe(1);
    expect(p.winRate).toEqual({ bound: 1, decided: 2, rate: 0.5 });
  });
});
