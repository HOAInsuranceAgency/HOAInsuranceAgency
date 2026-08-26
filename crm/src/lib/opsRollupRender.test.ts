import { describe, expect, it } from "vitest";
import { renderRollup, type RollupInput } from "../../amplify/functions/ops-rollup/render";
import type { Finding } from "../../amplify/functions/ops-rollup/detect";
import type { DoneResult } from "../../amplify/functions/ops-rollup/done";
import type { Progress } from "../../amplify/functions/ops-rollup/progress";
import { editionFor } from "../../amplify/functions/ops-rollup/window";
import { fmtMoney } from "./client";

/**
 * The email itself.
 *
 * Two things are worth holding here. One is that a quiet weekday still sends
 * something that says so — the all-clear line is the payload on most mornings,
 * and without it a broken query and a good day look identical. The other is
 * that nothing a user typed reaches the HTML unescaped: association names come
 * from a public web form.
 */

const TUESDAY = editionFor(new Date("2026-08-25T11:20:00Z"));
const SATURDAY = editionFor(new Date("2026-08-22T11:20:00Z"));

const EMPTY_DONE: DoneResult = {
  summary: {
    bound: [],
    boundPremium: 0,
    boundWithoutCommission: 0,
    commission: 0,
    newClients: [],
    certificates: 0,
    quotesAdvanced: 0,
    invoicesSent: 0,
    invoicesSentTotal: null,
    invoicesSentUnpriced: 0,
    invoicesPaid: 0,
    invoicesPaidTotal: null,
    tasksClosed: 0,
    tasksQuoted: 0,
    downPayments: 0,
    downPaymentTotal: 0,
    installments: 0,
    installmentTotal: 0,
    installmentInterest: 0,
    empty: true,
  },
  people: [],
  automatedChanges: 0,
  unmatchedClosers: 0,
  quiet: [],
};

const EMPTY_PROGRESS: Progress = {
  won: [],
  lost: [],
  monthLabel: "August",
  mtdPremium: 0,
  mtdCommission: 0,
  mtdPolicies: 0,
  mtdWithoutCommission: 0,
  priorPremium: 0,
  priorPolicies: 0,
  pacePct: null,
  pipeline: [],
  pipelineTotal: 0,
  pipelineCount: 0,
  decisionsDue: { count: 0, premium: 0, days: 30 },
  winRate: { bound: 0, decided: 0, rate: null },
  activePolicies: 0,
  clients: 0,
  leads: 0,
};

const finding = (over: Partial<Finding> = {}): Finding => ({
  kind: "coverage-gap-unmarketed",
  band: "exposed",
  severity: "red",
  accountId: "a1",
  subject: "Maple Ridge Condominium",
  clause: "expired 4d ago, no marketing, no quote",
  ageDays: 4,
  amount: 41200,
  href: "/accounts/a1?tab=quotes",
  visibility: "row",
  ...over,
});

const input = (over: Partial<RollupInput> = {}): RollupInput => ({
  edition: TUESDAY,
  findings: [],
  done: EMPTY_DONE,
  progress: EMPTY_PROGRESS,
  read: null,
  reads: { "activity rows": 1240, invoices: 318 },
  truncated: false,
  baseUrl: "https://crm.example.com",
  ...over,
});

describe("the subject line", () => {
  it("names only the parts that are non-zero, worst first", () => {
    const { subject } = renderRollup(
      input({
        findings: [finding(), finding({ band: "closing", severity: "amber" })],
      })
    );
    expect(subject).toBe("Ops — Tue, Aug 25 · 1 exposed · 1 closing");
  });

  it("says so plainly when there is nothing to report", () => {
    expect(renderRollup(input()).subject).toBe("Ops — Tue, Aug 25 · all clear");
  });

  /** This is what shows in a phone's notification preview. */
  it("names no audience and no purpose", () => {
    const { subject } = renderRollup(input({ findings: [finding()] }));
    expect(subject).not.toMatch(/owner|private|confidential|jake/i);
  });
});

describe("a quiet weekday", () => {
  /**
   * The all-clear line is the payload on most mornings. Without it a short
   * email is ambiguous — nothing wrong, or the query broke? — and nothing in
   * this codebase alarms when a scheduled function fails to send.
   */
  it("still states what was checked and found clear", () => {
    const { text, html } = renderRollup(input());
    expect(text).toContain("Clear: no coverage gaps");
    expect(html).toContain("no cancellation clocks");
  });

  it("reports the day's own emptiness as a finding", () => {
    expect(renderRollup(input()).text).toContain("Nothing was recorded in the CRM.");
  });

  it("says when a read stopped short rather than quietly under-reporting", () => {
    expect(renderRollup(input({ truncated: true })).text).toContain("page cap");
  });
});

describe("the weekend edition", () => {
  it("carries exposures only — no activity, no producers, no scoreboard", () => {
    const { text } = renderRollup(
      input({
        edition: SATURDAY,
        findings: [finding(), finding({ band: "closing", severity: "amber" })],
        progress: { ...EMPTY_PROGRESS, mtdPremium: 412000, mtdPolicies: 7 },
        done: {
          ...EMPTY_DONE,
          people: [
            {
              actor: "s1",
              name: "Sarah Chen",
              role: "PRODUCER",
              accountsTouched: 4,
              quotesAdvanced: 1,
              policiesBound: 0,
              tasksClosed: 0,
              trailingAccounts: 19,
            },
          ],
        },
      })
    );
    expect(text).toContain("Maple Ridge");
    expect(text).not.toContain("THE BUSINESS");
    expect(text).not.toContain("WHO MOVED THINGS");
    expect(text).not.toContain("Sarah Chen");
  });
});

describe("the business block", () => {
  it("puts the month against the same point in the last one", () => {
    const { text } = renderRollup(
      input({
        progress: {
          ...EMPTY_PROGRESS,
          mtdPremium: 412000,
          mtdPolicies: 7,
          mtdCommission: 49440,
          priorPremium: 349000,
          pacePct: 0.18,
        },
      })
    );
    expect(text).toContain("August to date: $412,000 bound across 7 policies");
    expect(text).toContain("18% ahead of the same point last month");
  });

  it("says which way it is going when the month is behind", () => {
    const { text } = renderRollup(
      input({ progress: { ...EMPTY_PROGRESS, mtdPremium: 100, priorPremium: 200, pacePct: -0.5 } })
    );
    expect(text).toContain("50% behind");
  });

  it("prices the pipeline and names the decisions that are close", () => {
    const { text } = renderRollup(
      input({
        progress: {
          ...EMPTY_PROGRESS,
          pipeline: [{ stage: "SUBMITTED", count: 3, premium: 90000 }],
          pipelineTotal: 90000,
          pipelineCount: 3,
          decisionsDue: { count: 2, premium: 60000, days: 30 },
        },
      })
    );
    expect(text).toContain("In flight: $90,000 across 3 open quotes");
    expect(text).toContain("2 decisions due within 30d");
  });

  it("flags a commission total that is really a floor", () => {
    const { text } = renderRollup(
      input({
        progress: { ...EMPTY_PROGRESS, mtdPremium: 1, mtdCommission: 1, mtdWithoutCommission: 3 },
      })
    );
    expect(text).toContain("3 with no commission % on file");
  });

  it("names what was won and lost, and how it was lost", () => {
    const { text } = renderRollup(
      input({
        progress: {
          ...EMPTY_PROGRESS,
          won: [{ account: "Maple Ridge", premium: 41200, detail: "Travelers" }],
          lost: [{ account: "Harbour Point", premium: 18000, detail: "carrier declined" }],
        },
      })
    );
    expect(text).toContain("Won: Maple Ridge $41,200 (Travelers)");
    expect(text).toContain("Lost: Harbour Point $18,000 — carrier declined");
  });
});

describe("the model's paragraph", () => {
  it("leads the email when there is one", () => {
    const { text, html } = renderRollup(
      input({ read: "Maple Ridge is uninsured as far as this system knows." })
    );
    expect(text).toContain("Maple Ridge is uninsured");
    expect(html).toContain("Maple Ridge is uninsured");
    // Above the lists.
    expect(text.indexOf("Maple Ridge is uninsured")).toBeLessThan(text.indexOf("Clear:"));
  });

  it("is simply absent when the model had nothing to say", () => {
    const { html } = renderRollup(input({ read: null }));
    expect(html).not.toContain("border-left:3px solid #142a4c");
  });

  it("escapes it like any other untrusted string", () => {
    const { html } = renderRollup(input({ read: "<script>alert(1)</script>" }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("rows", () => {
  /** Association names come from a public web form. */
  it("escapes markup in an account name", () => {
    const { html } = renderRollup(
      input({ findings: [finding({ subject: '<img src=x onerror="alert(1)">' })] })
    );
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("caps a long block and counts the rest", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      finding({ subject: `Association ${i}`, ageDays: i })
    );
    const { text } = renderRollup(input({ findings: many }));
    expect(text).toContain("+4 more");
  });

  it("folds a pile of small overdue bills into one line", () => {
    const small = Array.from({ length: 3 }, (_, i) =>
      finding({
        kind: "invoice-past-due",
        band: "money",
        severity: "amber",
        subject: `Small ${i}`,
        amount: 400,
      })
    );
    const { text } = renderRollup(input({ findings: small }));
    expect(text).toContain("and 3 smaller overdue invoices, $1,200");
  });

  it("orders exposures oldest first — the silence is the aggravating fact", () => {
    const { text } = renderRollup(
      input({
        findings: [
          finding({ subject: "Newer", ageDays: 2 }),
          finding({ subject: "Older", ageDays: 30 }),
        ],
      })
    );
    expect(text.indexOf("Older")).toBeLessThan(text.indexOf("Newer"));
  });

  it("keeps a demoted finding as a counter rather than dropping it", () => {
    const { text } = renderRollup(
      input({ findings: [finding({ kind: "quote-stalled", visibility: "standing" })] })
    );
    expect(text).toContain("Standing: 1 stalled quote");
  });

  it("still renders without a base url, just without links", () => {
    const { html } = renderRollup(input({ baseUrl: undefined, findings: [finding()] }));
    expect(html).toContain("Maple Ridge Condominium");
    expect(html).not.toContain("<a href");
  });
});

describe("the producer block", () => {
  const withPeople = () =>
    input({
      done: {
        ...EMPTY_DONE,
        people: [
          {
            actor: "s1",
            name: "Sarah Chen",
            role: "PRODUCER",
            accountsTouched: 7,
            quotesAdvanced: 1,
            policiesBound: 0,
            tasksClosed: 2,
            trailingAccounts: 31,
          },
        ],
        automatedChanges: 41,
        unmatchedClosers: 2,
      },
    });

  /**
   * The sentence that stops an effort count being read as a performance
   * measure. It is fixed, and it renders every single day.
   */
  it("carries the caveat under every producer block", () => {
    const { text, html } = renderRollup(withPeople());
    expect(text).toContain("calls, carrier emails, inspections and board meetings");
    expect(html).toContain("calls, carrier emails, inspections and board meetings");
  });

  it("shows the trailing figure beside the day's", () => {
    expect(renderRollup(withPeople()).text).toContain("10-day: 31");
  });

  it("says when closed tasks matched nobody rather than guessing", () => {
    expect(renderRollup(withPeople()).html).toContain("matched no profile");
  });
});

describe("money formatting", () => {
  /**
   * Restated in render.ts because client.ts would drag the browser data client
   * into the Lambda bundle. This is what keeps the two copies rounding alike.
   */
  it("rounds the way the dashboard does", () => {
    const { text } = renderRollup(
      input({ findings: [finding({ amount: 41200.49 })] })
    );
    expect(text).toContain(fmtMoney(41200.49));
  });

  it("prints an em dash, never $0, for an unknown amount", () => {
    const { text } = renderRollup(
      input({
        progress: {
          ...EMPTY_PROGRESS,
          won: [{ account: "Willow Bend", premium: null, detail: null }],
        },
      })
    );
    expect(text).toContain("Won: Willow Bend —");
    expect(text).not.toContain("Won: Willow Bend $0");
  });
});
