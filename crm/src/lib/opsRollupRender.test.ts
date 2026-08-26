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
 * Three things are worth holding here. The action list is ONE list now, so the
 * ranking inside it is the only thing standing between a coverage gap and
 * being buried under overdue invoices — the section headings used to do that
 * work. A quiet weekday must still send something that says so, or a broken
 * query and a good day look identical. And nothing a user typed reaches the
 * HTML unescaped: association names come from a public web form.
 */

const TUESDAY = editionFor(new Date("2026-08-25T11:20:00Z"));
const MONDAY = editionFor(new Date("2026-08-24T11:20:00Z"));
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
  truncated: false,
  baseUrl: "https://crm.example.com",
  ...over,
});

describe("the subject line", () => {
  it("splits urgent from the rest, and names neither when zero", () => {
    const { subject } = renderRollup(
      input({
        findings: [finding(), finding({ band: "closing", severity: "amber" })],
      })
    );
    expect(subject).toBe("Ops — Tue, Aug 25 · 1 urgent, 1 open");
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

/**
 * The merge of what used to be three sections. The headings carried the
 * ranking; now the sort does, so this is where that has to be proved.
 */
describe("the action list", () => {
  it("is one list, under one heading", () => {
    const { text } = renderRollup(
      input({
        findings: [
          finding(),
          finding({ band: "closing", severity: "amber", subject: "Willow Bend" }),
          finding({ band: "money", severity: "amber", subject: "Stonegate", amount: 18400 }),
        ],
      })
    );
    expect(text).toContain("NEEDS YOU (3)");
    expect(text).not.toContain("EXPOSED");
    expect(text).not.toContain("CLOSING WINDOWS");
    expect(text).not.toContain("MONEY AT RISK");
  });

  it("puts every urgent row above every non-urgent one", () => {
    const { text } = renderRollup(
      input({
        findings: [
          finding({ band: "closing", severity: "amber", subject: "Amber One" }),
          finding({ band: "money", severity: "amber", subject: "Amber Two", amount: 90000 }),
          finding({ band: "money", severity: "red", subject: "Red One", amount: 100 }),
        ],
      })
    );
    // Even with the smallest amount, the red row leads.
    expect(text.indexOf("Red One")).toBeLessThan(text.indexOf("Amber Two"));
    expect(text.indexOf("Red One")).toBeLessThan(text.indexOf("Amber One"));
  });

  it("ranks coverage above money above pipeline within a severity", () => {
    const { text } = renderRollup(
      input({
        findings: [
          finding({ band: "closing", severity: "red", subject: "Pipeline" }),
          finding({ band: "money", severity: "red", subject: "Money", amount: 1 }),
          finding({ band: "exposed", severity: "red", subject: "Coverage" }),
        ],
      })
    );
    expect(text.indexOf("Coverage")).toBeLessThan(text.indexOf("Money"));
    expect(text.indexOf("Money")).toBeLessThan(text.indexOf("Pipeline"));
  });

  it("sorts money by dollars and everything else by how long it has been true", () => {
    const byMoney = renderRollup(
      input({
        findings: [
          finding({ band: "money", severity: "amber", subject: "Small", amount: 9000, ageDays: 90 }),
          finding({ band: "money", severity: "amber", subject: "Large", amount: 90000, ageDays: 2 }),
        ],
      })
    ).text;
    expect(byMoney.indexOf("Large")).toBeLessThan(byMoney.indexOf("Small"));

    const byAge = renderRollup(
      input({
        findings: [
          finding({ subject: "Newer", ageDays: 2 }),
          finding({ subject: "Older", ageDays: 30 }),
        ],
      })
    ).text;
    expect(byAge.indexOf("Older")).toBeLessThan(byAge.indexOf("Newer"));
  });

  /**
   * The cap is what makes the merge safe. Eight ambers must not be able to
   * push a red off the bottom.
   */
  it("never lets the cap hide an urgent row", () => {
    const ambers = Array.from({ length: 12 }, (_, i) =>
      finding({ severity: "amber", band: "closing", subject: `Amber ${i}`, ageDays: 100 })
    );
    const { text } = renderRollup(
      input({ findings: [...ambers, finding({ subject: "The urgent one" })] })
    );
    expect(text).toContain("The urgent one");
    expect(text).toContain("+5 more");
    expect(text).toContain("NEEDS YOU (13)");
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

  it("keeps a demoted finding as a counter rather than dropping it", () => {
    const { text } = renderRollup(
      input({ findings: [finding({ kind: "quote-stalled", visibility: "standing" })] })
    );
    expect(text).toContain("Standing: 1 stalled quote");
    expect(text).not.toContain("NEEDS YOU");
  });
});

describe("the figures", () => {
  it("reads as a strip, not a sentence", () => {
    const { text } = renderRollup(
      input({
        progress: {
          ...EMPTY_PROGRESS,
          mtdPremium: 412000,
          mtdPolicies: 7,
          priorPremium: 349000,
          pacePct: 0.18,
          pipelineTotal: 132100,
          pipelineCount: 4,
          decisionsDue: { count: 2, premium: 60000, days: 30 },
        },
        findings: [finding()],
      })
    );
    expect(text).toContain("$412,000 August bound (▲ 18% vs last month)");
    expect(text).toContain("$132,100 in flight (2 decisions due in 30d)");
    expect(text).toContain("1 needs you (1 urgent)");
  });

  it("points the arrow the other way when the month is behind", () => {
    const { text } = renderRollup(
      input({ progress: { ...EMPTY_PROGRESS, mtdPremium: 100, priorPremium: 200, pacePct: -0.5 } })
    );
    expect(text).toContain("▼ 50% vs last month");
  });

  it("says none urgent rather than leaving the count bare", () => {
    const { text } = renderRollup(
      input({ findings: [finding({ severity: "amber", band: "closing" })] })
    );
    expect(text).toContain("1 needs you (none urgent)");
  });
});

describe("yesterday", () => {
  /**
   * `progress.won` and `done.summary.bound` are the same policies counted by
   * two modules. The old layout printed both, one line under the other.
   */
  it("names a bind once, not twice", () => {
    const { text } = renderRollup(
      input({
        progress: {
          ...EMPTY_PROGRESS,
          won: [{ account: "Maple Ridge", premium: 41200, detail: "Travelers" }],
        },
        done: {
          ...EMPTY_DONE,
          summary: {
            ...EMPTY_DONE.summary,
            empty: false,
            bound: [{ account: "Maple Ridge", premium: 41200, carrier: "Travelers" }],
            quotesAdvanced: 2,
          },
        },
      })
    );
    expect(text.match(/Maple Ridge/g)).toHaveLength(1);
    expect(text).toContain("Won   Maple Ridge $41,200 · Travelers");
    expect(text).not.toContain("Bound:");
  });

  it("names what was lost and how", () => {
    const { text } = renderRollup(
      input({
        progress: {
          ...EMPTY_PROGRESS,
          lost: [{ account: "Harbour Point", premium: 18000, detail: "carrier declined" }],
        },
      })
    );
    expect(text).toContain("Lost   Harbour Point $18,000 · carrier declined");
  });

  it("collapses everything with no name worth printing into one line", () => {
    const { text } = renderRollup(
      input({
        done: {
          ...EMPTY_DONE,
          summary: {
            ...EMPTY_DONE.summary,
            empty: false,
            quotesAdvanced: 2,
            certificates: 3,
            invoicesSent: 2,
            invoicesSentTotal: 52200,
            invoicesPaid: 1,
            invoicesPaidTotal: 19400,
            tasksClosed: 3,
            tasksQuoted: 2,
          },
        },
      })
    );
    expect(text).toContain(
      "2 quotes advanced · 3 COIs issued · 2 bills sent $52,200 · 1 paid $19,400 · 3 tasks closed (2 quoted)"
    );
  });

  it("reports the day's own emptiness as a finding", () => {
    expect(renderRollup(input()).text).toContain("Nothing was recorded in the CRM.");
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
    expect(text).toContain("Won   Willow Bend —");
    expect(text).not.toContain("Won   Willow Bend $0");
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
    expect(text).toContain("Checked and clear: no coverage gaps");
    expect(html).toContain("no cancellation clocks");
  });

  it("says when a read stopped short rather than quietly under-reporting", () => {
    expect(renderRollup(input({ truncated: true })).text).toContain("page cap");
  });
});

describe("the weekend edition", () => {
  it("carries the action list only — no figures, no activity, no producers", () => {
    const { text } = renderRollup(
      input({
        edition: SATURDAY,
        findings: [finding()],
        progress: { ...EMPTY_PROGRESS, mtdPremium: 412000 },
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
    expect(text).not.toContain("August bound");
    expect(text).not.toContain("WHO MOVED THINGS");
    expect(text).not.toContain("YESTERDAY");
    expect(text).not.toContain("Sarah Chen");
  });
});

describe("the model's paragraph", () => {
  it("leads the email when there is one", () => {
    const { text, html } = renderRollup(
      input({ read: "Maple Ridge is uninsured as far as this system knows." })
    );
    expect(text).toContain("Maple Ridge is uninsured");
    expect(html).toContain("Maple Ridge is uninsured");
    expect(text.indexOf("Maple Ridge is uninsured")).toBeLessThan(
      text.indexOf("Checked and clear")
    );
  });

  it("escapes it like any other untrusted string", () => {
    const { html } = renderRollup(input({ read: "<script>alert(1)</script>" }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
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

  it("asks about a quiet producer on Monday only", () => {
    const quiet = {
      ...EMPTY_DONE,
      quiet: [{ name: "Dana Whitfield", businessDays: 7, beyondScan: false }],
    };
    expect(renderRollup(input({ done: quiet })).text).not.toContain("Dana Whitfield");
    const monday = renderRollup(input({ edition: MONDAY, done: quiet })).text;
    expect(monday).toContain("Dana Whitfield — no CRM writes in 7 business days");
    expect(monday).toContain("worth a check-in?");
  });
});

describe("markup", () => {
  /** Association names come from a public web form. */
  it("escapes markup in an account name", () => {
    const { html } = renderRollup(
      input({ findings: [finding({ subject: '<img src=x onerror="alert(1)">' })] })
    );
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("still renders without a base url, just without links", () => {
    const { html } = renderRollup(input({ baseUrl: undefined, findings: [finding()] }));
    expect(html).toContain("Maple Ridge Condominium");
    expect(html).not.toContain("<a href");
  });

  /**
   * Restated in render.ts because client.ts would drag the browser data client
   * into the Lambda bundle. This is what keeps the two copies rounding alike.
   */
  it("rounds money the way the dashboard does", () => {
    const { text } = renderRollup(input({ findings: [finding({ amount: 41200.49 })] }));
    expect(text).toContain(fmtMoney(41200.49));
  });
});
