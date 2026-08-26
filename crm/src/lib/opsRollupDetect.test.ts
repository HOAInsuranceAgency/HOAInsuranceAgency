import { describe, expect, it } from "vitest";
import {
  THRESHOLDS,
  buildFindings,
  visibility,
  type DetectInputs,
  type Finding,
  type FindingKind,
} from "../../amplify/functions/ops-rollup/detect";
import { editionFor } from "../../amplify/functions/ops-rollup/window";
import { MARKETING_SUBMIT_SCALE } from "./badges";

/**
 * What the rollup calls a miss.
 *
 * These rules decide what lands in front of the owner every morning, so the
 * failure that matters most is not a missing row — it is a wrong one. A
 * digest that reports a resolved cancellation as live, or accuses somebody of
 * not billing a direct-bill policy, is read twice and then filed unread, and
 * the real coverage gap goes with it.
 */

/** 2026-08-25 is a Tuesday. 07:20 Eastern is 11:20 UTC. */
const TUESDAY = editionFor(new Date("2026-08-25T11:20:00Z"));
const MONDAY = editionFor(new Date("2026-08-24T11:20:00Z"));

const EMPTY: DetectInputs = {
  leads: [],
  clients: [],
  policies: [],
  quotes: [],
  invoices: [],
  tasks: [],
  loans: [],
  notices: [],
  leadReplies: [],
  licenses: [],
  premiumFinanceEnabled: true,
};

const inputs = (over: Partial<DetectInputs> = {}): DetectInputs => ({
  ...EMPTY,
  ...over,
});

const kinds = (f: Finding[]): FindingKind[] => f.map((x) => x.kind);
const only = (f: Finding[], kind: FindingKind) => f.filter((x) => x.kind === kind);

/** A client with one ACTIVE policy expiring on `expiration`. */
const withPolicy = (expiration: string, over: Partial<DetectInputs["policies"][number]> = {}) =>
  inputs({
    clients: [{ id: "a1", name: "Maple Ridge Condominium" }],
    policies: [
      {
        id: "p1",
        accountId: "a1",
        status: "ACTIVE",
        expirationDate: expiration,
        premium: 41200,
        ...over,
      },
    ],
  });

describe("the rungs match the badge on the Tasks screen", () => {
  /**
   * The email's colour and the screen's badge have to turn on the same day.
   * SOON_DAYS is restated in detect.ts because badges.tsx would drag React
   * into the Lambda bundle, so this is the thing keeping the copies equal.
   */
  it("uses MARKETING_SUBMIT_SCALE's soon threshold", () => {
    expect(THRESHOLDS.SOON_DAYS).toBe(MARKETING_SUBMIT_SCALE.soon);
  });
});

describe("coverage gaps", () => {
  it("reports an expired policy with no marketing and no quote", () => {
    const f = only(buildFindings(withPolicy("2026-08-21"), TUESDAY), "coverage-gap-unmarketed");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("red");
    expect(f[0].band).toBe("exposed");
    expect(f[0].clause).toContain("expired 4d ago");
    expect(f[0].amount).toBe(41200);
  });

  /**
   * The trap the nightly sweep sets: it deliberately never CREATES a task for
   * a carrier it has already quoted, so "no MarketingTask row" does not mean
   * "nobody started". A surface that infers one from the other renders the
   * best-case renewal as the worst.
   */
  it("is not a gap when a quote landed inside the marketing window", () => {
    const withQuote = {
      ...withPolicy("2026-08-21"),
      quotes: [
        {
          id: "q1",
          accountId: "a1",
          status: "SUBMITTED",
          createdAt: "2026-07-20T12:00:00Z",
        },
      ],
    };
    expect(kinds(buildFindings(withQuote, TUESDAY))).not.toContain(
      "coverage-gap-unmarketed"
    );
  });

  it("stops reporting once it is archaeology rather than live work", () => {
    // 40 days past, beyond the 30-day horizon borrowed from attention.ts.
    expect(
      kinds(buildFindings(withPolicy("2026-07-16"), TUESDAY))
    ).not.toContain("coverage-gap-unmarketed");
  });

  it("calls it a blown window, not a gap, when somebody did try", () => {
    const tried = {
      ...withPolicy("2026-08-21"),
      tasks: [
        {
          accountId: "a1",
          expirationDate: "2026-08-21",
          status: "OPEN",
          submitBy: "2026-07-22",
          carrierName: "CAU",
        },
      ],
    };
    const f = buildFindings(tried, TUESDAY);
    expect(kinds(f)).toContain("submission-window-blown");
    expect(kinds(f)).not.toContain("coverage-gap-unmarketed");
  });
});

describe("renewals still ahead", () => {
  it("reports nothing started inside the sweep's own horizon", () => {
    const f = only(buildFindings(withPolicy("2026-09-25"), TUESDAY), "renewal-not-started");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("amber"); // 31 days out
    expect(f[0].clause).toContain("renews in 31d");
  });

  it("turns red once inside the submission rung", () => {
    const f = only(buildFindings(withPolicy("2026-09-10"), TUESDAY), "renewal-not-started");
    expect(f[0].severity).toBe("red"); // 16 days out, inside SOON_DAYS
  });

  it("says nothing about a renewal still beyond the horizon", () => {
    expect(kinds(buildFindings(withPolicy("2026-11-01"), TUESDAY))).not.toContain(
      "renewal-not-started"
    );
  });

  it("says nothing when tasks are open and on time", () => {
    const started = {
      ...withPolicy("2026-09-25"),
      tasks: [
        {
          accountId: "a1",
          expirationDate: "2026-09-25",
          status: "OPEN",
          submitBy: "2026-09-01",
        },
      ],
    };
    expect(kinds(buildFindings(started, TUESDAY))).not.toContain("renewal-not-started");
  });
});

describe("invoices", () => {
  const invoice = (over: Partial<DetectInputs["invoices"][number]> = {}) =>
    inputs({
      clients: [{ id: "a1", name: "Stonegate" }],
      invoices: [
        {
          id: "i1",
          accountId: "a1",
          number: "INV-2026-00142",
          status: "SENT",
          dueAt: "2026-08-01",
          stripeLinkAmountCents: 1_840_000,
          ...over,
        },
      ],
    });

  it("says nothing about a bill that is merely a few days late", () => {
    // Net-14 is the house term; two days late is ordinary, and reporting it is
    // how a reader learns to stop opening the email.
    expect(kinds(buildFindings(invoice({ dueAt: "2026-08-23" }), TUESDAY))).not.toContain(
      "invoice-past-due"
    );
  });

  it("reports it amber from ten days and red from thirty", () => {
    const amber = only(buildFindings(invoice({ dueAt: "2026-08-13" }), TUESDAY), "invoice-past-due");
    expect(amber[0].severity).toBe("amber");
    const red = only(buildFindings(invoice({ dueAt: "2026-07-20" }), TUESDAY), "invoice-past-due");
    expect(red[0].severity).toBe("red");
    expect(red[0].amount).toBe(18_400);
  });

  /**
   * PROCESSING exists in the schema only because ACH authorises at checkout
   * and settles days later. Chasing money already in flight is the exact
   * false positive that would cost this section its reader.
   */
  it("leaves an ACH payment alone while it is still settling", () => {
    const settling = invoice({
      status: "PROCESSING",
      dueAt: "2026-08-13",
      stripeEventAt: "2026-08-24T12:00:00Z",
    });
    expect(kinds(buildFindings(settling, TUESDAY))).not.toContain("invoice-past-due");
  });

  it("reports a PROCESSING invoice once settlement has clearly stalled", () => {
    const stalled = invoice({
      status: "PROCESSING",
      dueAt: "2026-08-13",
      stripeEventAt: "2026-08-01T12:00:00Z",
    });
    expect(kinds(buildFindings(stalled, TUESDAY))).toContain("invoice-past-due");
  });

  it("never reports a bill that stated no deadline", () => {
    expect(kinds(buildFindings(invoice({ dueAt: null }), TUESDAY))).not.toContain(
      "invoice-past-due"
    );
  });
});

describe("bound and unbilled", () => {
  const bound = (over: Partial<DetectInputs["policies"][number]> = {}) =>
    inputs({
      clients: [{ id: "a1", name: "Harbour Point" }],
      policies: [
        {
          id: "p1",
          accountId: "a1",
          status: "ACTIVE",
          billType: "AGENCY",
          datePolicyBound: "2026-08-10T14:00:00Z",
          premium: 31000,
          ...over,
        },
      ],
    });

  it("reports an agency-bill policy nobody invoiced", () => {
    const f = only(buildFindings(bound(), TUESDAY), "bound-not-billed");
    expect(f).toHaveLength(1);
    expect(f[0].clause).toContain("never invoiced");
    expect(f[0].amount).toBe(31000);
  });

  /**
   * `billType` is nullable. One false accusation on a direct-bill policy is
   * how this section loses credibility, so a null is never guessed at.
   */
  it("never accuses a direct-bill or an unrecorded-bill policy", () => {
    expect(kinds(buildFindings(bound({ billType: "DIRECT" }), TUESDAY))).not.toContain(
      "bound-not-billed"
    );
    expect(kinds(buildFindings(bound({ billType: null }), TUESDAY))).not.toContain(
      "bound-not-billed"
    );
  });

  it("skips a policy with no bind date rather than treating it as ancient", () => {
    // The field is nullable for policies bound before it existed.
    expect(kinds(buildFindings(bound({ datePolicyBound: null }), TUESDAY))).not.toContain(
      "bound-not-billed"
    );
  });

  it("allows a working week of paperwork grace", () => {
    expect(
      kinds(buildFindings(bound({ datePolicyBound: "2026-08-24T14:00:00Z" }), TUESDAY))
    ).not.toContain("bound-not-billed");
  });

  it("clears once a bill exists, and says so when one is only drafted", () => {
    const billed = {
      ...bound(),
      invoices: [{ id: "i1", accountId: "a1", status: "SENT", policyId: "p1" }],
    };
    expect(kinds(buildFindings(billed, TUESDAY))).not.toContain("bound-not-billed");

    const drafted = {
      ...bound(),
      invoices: [{ id: "i1", accountId: "a1", status: "DRAFT", policyId: "p1" }],
    };
    const f = only(buildFindings(drafted, TUESDAY), "bound-not-billed");
    expect(f[0].clause).toContain("still in draft");
  });

  it("clears through the quote anchor when the invoice was raised pre-bind", () => {
    // Quote-anchored billing rolls to the policy at bind; the invoice keeps
    // its quoteId.
    const viaQuote = {
      ...bound({ quoteId: "q1" }),
      invoices: [{ id: "i1", accountId: "a1", status: "SENT", quoteId: "q1" }],
    };
    expect(kinds(buildFindings(viaQuote, TUESDAY))).not.toContain("bound-not-billed");
  });
});

describe("premium finance", () => {
  const loan = (over: Partial<DetectInputs["loans"][number]> = {}) => ({
    id: "l1",
    accountId: "a1",
    status: "DEFAULTED",
    balance: 14220,
    defaultedAt: "2026-08-22T10:00:00Z",
    autopayFailedInstallment: 4,
    ...over,
  });
  const base = (over: Partial<DetectInputs> = {}) =>
    inputs({
      clients: [{ id: "a1", name: "Brookline Gardens" }],
      loans: [loan()],
      ...over,
    });

  /**
   * A loan going into default emails nobody today — pf-default-sweep's only
   * outbound mail is in its stale-marker loop. This is the loudest uncovered
   * failure in the system, which is why it reports from day one.
   */
  it("reports a default immediately", () => {
    const f = only(buildFindings(base(), TUESDAY), "loan-stuck");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("red");
    expect(f[0].clause).toContain("installment 4 failed");
  });

  it("lets a cured default fall out of the list", () => {
    const cured = base({ loans: [loan({ status: "ACTIVE", defaultedAt: null })] });
    expect(kinds(buildFindings(cured, TUESDAY))).not.toContain("loan-stuck");
  });

  it("reports a debit that has been pending past the sweep's own limit", () => {
    const stuck = base({
      loans: [
        loan({
          status: "ACTIVE",
          defaultedAt: null,
          autopayFailedInstallment: null,
          autopayPendingIntentId: "pi_1",
          autopayAttemptedAt: "2026-08-10T10:00:00Z",
        }),
      ],
    });
    const f = only(buildFindings(stuck, TUESDAY), "loan-stuck");
    expect(f[0].clause).toContain("debit stuck");
  });

  /**
   * Curing a default sets the loan back to ACTIVE and clears defaultedAt, but
   * the notice row is immutable and its clock keeps running on paper. Without
   * episode scoping this reports a resolved cancellation as live, every
   * morning, forever.
   */
  it("does not treat a previous episode's notice as a running clock", () => {
    const stale = base({
      loans: [loan({ defaultedAt: "2026-08-22T10:00:00Z" })],
      notices: [
        {
          loanId: "l1",
          type: "INTENT_TO_CANCEL",
          occurredAt: "2026-07-01T10:00:00Z", // before this default episode
          clockExpiresAt: "2026-09-05T10:00:00Z",
        },
      ],
    });
    expect(kinds(buildFindings(stale, TUESDAY))).not.toContain("finance-cancellation-clock");
  });

  it("reports this episode's clock, with the days left", () => {
    const live = base({
      notices: [
        {
          loanId: "l1",
          type: "INTENT_TO_CANCEL",
          occurredAt: "2026-08-23T10:00:00Z",
          clockExpiresAt: "2026-08-28T10:00:00Z",
        },
      ],
    });
    const f = only(buildFindings(live, TUESDAY), "finance-cancellation-clock");
    expect(f).toHaveLength(1);
    expect(f[0].clause).toContain("3 days left");
  });

  it("stops once the cancellation has actually been requested", () => {
    const requested = base({
      notices: [
        {
          loanId: "l1",
          type: "INTENT_TO_CANCEL",
          occurredAt: "2026-08-23T10:00:00Z",
          clockExpiresAt: "2026-08-28T10:00:00Z",
        },
        { loanId: "l1", type: "CANCELLATION_REQUEST", occurredAt: "2026-08-24T10:00:00Z" },
      ],
    });
    expect(kinds(buildFindings(requested, TUESDAY))).not.toContain(
      "finance-cancellation-clock"
    );
  });

  it("says nothing at all about financing when the module is dark", () => {
    const dark = { ...base(), premiumFinanceEnabled: false };
    const f = kinds(buildFindings(dark, TUESDAY));
    expect(f).not.toContain("loan-stuck");
    expect(f).not.toContain("finance-cancellation-clock");
    expect(f).not.toContain("finance-election-stalled");
  });

  it("waits a board cycle before chasing an unanswered finance offer", () => {
    const offer = (quotedAt: string) =>
      base({
        loans: [
          loan({
            status: "QUOTED",
            defaultedAt: null,
            autopayFailedInstallment: null,
            quotedAt,
            electionToken: "tok",
            amountFinanced: 30000,
          }),
        ],
      });
    expect(kinds(buildFindings(offer("2026-08-18T10:00:00Z"), TUESDAY))).not.toContain(
      "finance-election-stalled"
    );
    expect(kinds(buildFindings(offer("2026-08-01T10:00:00Z"), TUESDAY))).toContain(
      "finance-election-stalled"
    );
  });

  /**
   * A down-payment intent means the election is committed and an ACH payment
   * is clearing — a state that legitimately lasts days.
   */
  it("leaves an election alone once the down payment is clearing", () => {
    const clearing = base({
      loans: [
        loan({
          status: "QUOTED",
          defaultedAt: null,
          autopayFailedInstallment: null,
          quotedAt: "2026-08-01T10:00:00Z",
          electionToken: "tok",
          downPaymentIntentId: "pi_down",
        }),
      ],
    });
    expect(kinds(buildFindings(clearing, TUESDAY))).not.toContain("finance-election-stalled");
  });
});

describe("web leads that heard nothing", () => {
  const reply = (over: Partial<DetectInputs["leadReplies"][number]> = {}) =>
    inputs({
      leads: [{ id: "a1", name: "Cedar Court Condominium", createdAt: "2026-08-22T10:00:00Z" }],
      leadReplies: [
        {
          accountId: "a1",
          status: "FAILED",
          submittedAt: "2026-08-22T10:00:00Z",
          dueAt: "2026-08-22T10:08:00Z",
          ...over,
        },
      ],
    });

  it("reports a failed auto-reply — nothing else in the agency can see it", () => {
    const f = only(buildFindings(reply(), TUESDAY), "web-lead-heard-nothing");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("red");
  });

  it("leaves a window that is simply still open alone", () => {
    const waiting = reply({
      status: "WAITING",
      submittedAt: "2026-08-25T11:00:00Z",
      dueAt: "2026-08-25T11:08:00Z",
    });
    expect(kinds(buildFindings(waiting, TUESDAY))).not.toContain("web-lead-heard-nothing");
  });

  it("reports a window an hour past due as a broken sweep", () => {
    const overdue = reply({ status: "WAITING", dueAt: "2026-08-24T10:08:00Z" });
    expect(kinds(buildFindings(overdue, TUESDAY))).toContain("web-lead-heard-nothing");
  });
});

describe("leads and quotes", () => {
  it("reports a lead nobody has quoted after three business days", () => {
    const lead = inputs({
      leads: [{ id: "a1", name: "Willow Bend Homeowners", createdAt: "2026-08-19T10:00:00Z" }],
    });
    const f = only(buildFindings(lead, TUESDAY), "new-lead-untouched");
    expect(f).toHaveLength(1);
    expect(f[0].band).toBe("closing");
  });

  it("gives a lead from this morning time to be worked", () => {
    const fresh = inputs({
      leads: [{ id: "a1", name: "Willow Bend Homeowners", createdAt: "2026-08-24T10:00:00Z" }],
    });
    expect(kinds(buildFindings(fresh, TUESDAY))).not.toContain("new-lead-untouched");
  });

  /**
   * A lead every carrier declined was worked and lost — a different fact and a
   * different conversation from one nobody opened.
   */
  it("does not call a declined lead untouched", () => {
    const declined = inputs({
      leads: [{ id: "a1", name: "Willow Bend Homeowners", createdAt: "2026-08-12T10:00:00Z" }],
      quotes: [{ id: "q1", accountId: "a1", status: "DECLINED" }],
    });
    expect(kinds(buildFindings(declined, TUESDAY))).not.toContain("new-lead-untouched");
  });

  /**
   * Web forms produce test submissions. "Nobody followed up with asdf HOA"
   * reported as a service failure loses the reader on first occurrence.
   */
  it("ignores a junk association name", () => {
    const junk = inputs({
      leads: [{ id: "a1", name: "asdf", createdAt: "2026-08-12T10:00:00Z" }],
    });
    expect(kinds(buildFindings(junk, TUESDAY))).not.toContain("new-lead-untouched");
  });

  it("reports a quote whose effective date has passed while it is still open", () => {
    const passed = inputs({
      clients: [{ id: "a1", name: "Lakeview Estates" }],
      quotes: [
        {
          id: "q1",
          accountId: "a1",
          status: "PRESENTED",
          effectiveDate: "2026-08-20",
          updatedAt: "2026-08-24T10:00:00Z",
          premium: 22000,
        },
      ],
    });
    const f = only(buildFindings(passed, TUESDAY), "effective-date-passed");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("red");
  });

  it("says nothing about a bound quote whose date has passed", () => {
    const boundAlready = inputs({
      clients: [{ id: "a1", name: "Lakeview Estates" }],
      quotes: [{ id: "q1", accountId: "a1", status: "BOUND", effectiveDate: "2026-08-20" }],
    });
    expect(kinds(buildFindings(boundAlready, TUESDAY))).not.toContain("effective-date-passed");
  });

  /**
   * Quote stores none of its status transitions, so this is days since the row
   * was last WRITTEN. The row must never claim to know how long it sat at
   * SUBMITTED, because nothing in the schema does.
   */
  it("words a stalled quote as silence, not as time in status", () => {
    const stalled = inputs({
      clients: [{ id: "a1", name: "Birchwood Estates" }],
      quotes: [
        {
          id: "q1",
          accountId: "a1",
          status: "SUBMITTED",
          updatedAt: "2026-08-05T10:00:00Z",
        },
      ],
    });
    const f = only(buildFindings(stalled, TUESDAY), "quote-stalled");
    expect(f).toHaveLength(1);
    expect(f[0].clause).toContain("no write in");
    expect(f[0].clause).not.toContain("ago");
  });

  it("gives a carrier longer than it gives us", () => {
    const q = (status: string, updatedAt: string) =>
      inputs({
        clients: [{ id: "a1", name: "Birchwood Estates" }],
        quotes: [{ id: "q1", accountId: "a1", status, updatedAt }],
      });
    // Eight business days of silence: our ball at QUOTED, still the carrier's
    // at SUBMITTED.
    expect(kinds(buildFindings(q("QUOTED", "2026-08-13T10:00:00Z"), TUESDAY))).toContain(
      "quote-stalled"
    );
    expect(kinds(buildFindings(q("SUBMITTED", "2026-08-13T10:00:00Z"), TUESDAY))).not.toContain(
      "quote-stalled"
    );
  });
});

describe("lapsed producer licences", () => {
  /**
   * license-alerts fires a 60/30/3 ladder and writes a dedupe row per rung, so
   * once the 3-day rung has fired and the date passes, nothing ever mentions
   * it again.
   */
  it("reports a licence that actually lapsed", () => {
    const lapsed = inputs({
      licenses: [
        {
          holderType: "PRODUCER",
          holderName: "Sarah Chen",
          state: "MA",
          status: "ACTIVE",
          expirationDate: "2026-08-18",
        },
      ],
    });
    const f = only(buildFindings(lapsed, TUESDAY), "producer-licence-lapsed");
    expect(f).toHaveLength(1);
    expect(f[0].accountId).toBe(null);
    expect(f[0].subject).toBe("Sarah Chen");
  });

  it("leaves a licence that is merely approaching expiry to the licence ladder", () => {
    const soon = inputs({
      licenses: [
        {
          holderType: "PRODUCER",
          holderName: "Sarah Chen",
          state: "MA",
          status: "ACTIVE",
          expirationDate: "2026-09-15",
        },
      ],
    });
    expect(kinds(buildFindings(soon, TUESDAY))).not.toContain("producer-licence-lapsed");
  });

  it("says nothing about the firm's own licences here", () => {
    const firm = inputs({
      licenses: [{ holderType: "FIRM", state: "MA", expirationDate: "2026-08-18" }],
    });
    expect(kinds(buildFindings(firm, TUESDAY))).not.toContain("producer-licence-lapsed");
  });
});

describe("the age ladder", () => {
  it("hides a finding until it reaches its rung", () => {
    expect(visibility(2, 3, false, false)).toBe("hidden");
    expect(visibility(3, 3, false, false)).toBe("row");
  });

  /**
   * With no ledger, an exact-day rung is lost forever if one morning's send
   * fails — and nothing in this codebase alarms on a scheduled function that
   * does not send. Three days costs a couple of lines and survives that.
   */
  it("holds a full row for three days, then demotes to the standing line", () => {
    expect(visibility(4, 3, false, false)).toBe("row");
    expect(visibility(5, 3, false, false)).toBe("row");
    expect(visibility(6, 3, false, false)).toBe("standing");
  });

  it("re-expands a demoted finding on a Monday", () => {
    expect(visibility(20, 3, false, true)).toBe("row");
  });

  it("never demotes a finding whose outcome is a lapse", () => {
    expect(visibility(400, 0, true, false)).toBe("row");
  });

  it("keeps a coverage gap a full row weeks later, but not a stalled quote", () => {
    const gap = only(buildFindings(withPolicy("2026-08-01"), TUESDAY), "coverage-gap-unmarketed");
    expect(gap[0].visibility).toBe("row");

    const oldLead = inputs({
      leads: [{ id: "a1", name: "Willow Bend Homeowners", createdAt: "2026-08-12T10:00:00Z" }],
    });
    expect(only(buildFindings(oldLead, TUESDAY), "new-lead-untouched")[0].visibility).toBe(
      "standing"
    );
    expect(only(buildFindings(oldLead, MONDAY), "new-lead-untouched")[0].visibility).toBe("row");
  });
});
