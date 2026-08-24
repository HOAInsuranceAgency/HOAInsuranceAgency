import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  addDaysIso,
  canRecordCert,
  canRequestCancellation,
  CARRIER_REFUND_DAYS,
  latestIntent,
  NOTICE_DAYS,
  type NoticeRow,
} from "./noticeSequence";

/**
 * The ordering of the cancellation sequence — the rules an examiner reads
 * lender liability against. Every refusal names the missing step.
 */

const T0 = "2026-08-21T12:00:00.000Z";
const intent: NoticeRow = {
  id: "n1",
  type: "INTENT_TO_CANCEL",
  occurredAt: T0,
  clockExpiresAt: addDaysIso(T0, NOTICE_DAYS),
};
const cert: NoticeRow = {
  id: "n2",
  type: "CERT_OF_MAILING",
  occurredAt: addDaysIso(T0, 1),
  refNoticeId: "n1",
};

describe("the constants the statutes fix", () => {
  it("15 days' notice, 30 days' expected refund", () => {
    expect(NOTICE_DAYS).toBe(15);
    expect(CARRIER_REFUND_DAYS).toBe(30);
  });
});

describe("canRequestCancellation — the strict order", () => {
  it("refuses with no intent notice at all", () => {
    const v = canRequestCancellation([], T0);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("step one");
  });

  it("refuses an intent whose certificate is not recorded", () => {
    // A notice we cannot prove was mailed is a notice that was not mailed.
    const v = canRequestCancellation([intent], addDaysIso(T0, 20));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("certificate of mailing");
  });

  it("refuses inside the 15 days, naming the date the clock runs out", () => {
    const v = canRequestCancellation([intent, cert], addDaysIso(T0, 14));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain(intent.clockExpiresAt!.slice(0, 10));
  });

  it("permits at exactly the clock's expiry, and after", () => {
    expect(canRequestCancellation([intent, cert], intent.clockExpiresAt!).ok).toBe(true);
    expect(canRequestCancellation([intent, cert], addDaysIso(T0, 16)).ok).toBe(true);
  });

  it("refuses a second cancellation request", () => {
    const cancel: NoticeRow = {
      id: "n3",
      type: "CANCELLATION_REQUEST",
      occurredAt: addDaysIso(T0, 16),
      refNoticeId: "n1",
    };
    const v = canRequestCancellation([intent, cert, cancel], addDaysIso(T0, 20));
    expect(v.ok).toBe(false);
  });

  it("a certificate for a DIFFERENT notice does not count", () => {
    const strayCert: NoticeRow = { ...cert, refNoticeId: "n99" };
    const v = canRequestCancellation([intent, strayCert], addDaysIso(T0, 20));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("certificate");
  });

  it("the clock runs from the LATEST intent when notice was re-sent", () => {
    const reIntent: NoticeRow = {
      id: "n4",
      type: "INTENT_TO_CANCEL",
      occurredAt: addDaysIso(T0, 10),
      clockExpiresAt: addDaysIso(T0, 25),
    };
    const reCert: NoticeRow = {
      id: "n5",
      type: "CERT_OF_MAILING",
      occurredAt: addDaysIso(T0, 11),
      refNoticeId: "n4",
    };
    // 20 days after T0 is past the first clock but inside the second.
    const v = canRequestCancellation([intent, cert, reIntent, reCert], addDaysIso(T0, 20));
    expect(v.ok).toBe(false);
    expect(latestIntent([intent, reIntent]).intent?.id).toBe("n4");
  });
});

describe("canRecordCert", () => {
  it("records against an intent once, and only against an intent", () => {
    expect(canRecordCert([intent], "n1").ok).toBe(true);
    expect(canRecordCert([intent, cert], "n1").ok).toBe(false);
    expect(canRecordCert([intent], "nope").ok).toBe(false);
    expect(canRecordCert([cert], "n2").ok).toBe(false);
  });
});

/**
 * The structural properties: nothing in the sequence can be back-dated or
 * skipped through any client, because no client can write the rows at all,
 * and the handler accepts exactly two outside dates — both facts about
 * paper, not about clicks.
 */
describe("immutability and server time", () => {
  const SCHEMA = readFileSync(resolve(process.cwd(), "amplify/data/resource.ts"), "utf8");
  const HANDLER = readFileSync(
    resolve(process.cwd(), "amplify/functions/pf-servicing/handler.ts"),
    "utf8"
  );

  it("PfNotice and PfLoanPayment take no client writes", () => {
    for (const model of ["PfNotice: a", "PfLoanPayment: a"]) {
      const at = SCHEMA.indexOf(model);
      expect(at, model).toBeGreaterThan(-1);
      const block = SCHEMA.slice(at, SCHEMA.indexOf(".authorization", at) + 200);
      expect(block, model).toContain('allow.authenticated().to(["read"])');
      expect(block, model).not.toMatch(/"create"|"update"|"delete"/);
    }
  });

  it("every notice row's occurredAt is the server's clock", () => {
    // The only occurredAt values written are `now`, declared once from
    // new Date() — never from an argument.
    expect(HANDLER).toMatch(/const now = new Date\(\)\.toISOString\(\)/);
    expect(HANDLER).not.toMatch(/occurredAt:\s*a\./);
    expect((HANDLER.match(/occurredAt: now/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("accepts outside dates only for the USPS form and the carrier's effective date", () => {
    const dateArgs = [...HANDLER.matchAll(/a\.(\w+)\b/g)]
      .map((m) => m[1])
      .filter((name) =>
        /At$|Date/i.test(name)
      );
    expect(new Set(dateArgs)).toEqual(
      new Set(["boardResolutionExecutedAt", "certMailedAt", "cancellationEffectiveAt"])
    );
  });

  it("the servicing paths never import the origination gate", () => {
    expect(HANDLER).not.toContain("premiumFinance/gate");
    const SWEEP = readFileSync(
      resolve(process.cwd(), "amplify/functions/pf-default-sweep/handler.ts"),
      "utf8"
    );
    expect(SWEEP).not.toContain("premiumFinance/gate");
  });

  it("posting refuses while an autopay debit is clearing", () => {
    // W7 replaced the lending-account guard (decision 5, revised 2026-08-23:
    // one rail, trust settlement, split on the ledger) with the guard that
    // actually protects money now: a hand posting during a clearing debit
    // would collect the installment twice.
    expect(HANDLER).toContain("loan.autopayPendingIntentId");
    expect(HANDLER).toContain("would collect the money twice");
    expect(HANDLER).not.toContain("pfLendingAccountName");
  });

  it("the split comes from the frozen schedule, not from arithmetic here", () => {
    const POSTING = readFileSync(
      resolve(process.cwd(), "amplify/functions/pfPosting.ts"),
      "utf8"
    );
    expect(POSTING).toContain("interest: row.interest");
    expect(POSTING).toContain("principal: row.principal");
    // Decision 5, revised: the settlement rail is named on every row — the
    // ledger is where loan money stays distinct from premium now.
    expect(POSTING).toContain("PF_SETTLEMENT_RAIL");
  });
});

describe("isRealIsoDay — day-shaped is not a day", () => {
  it("accepts real days only", async () => {
    const { isRealIsoDay } = await import("./noticeSequence");
    expect(isRealIsoDay("2026-08-21")).toBe(true);
    expect(isRealIsoDay("2028-02-29")).toBe(true); // leap
  });

  it("rejects the strings that beat the old regex", async () => {
    const { isRealIsoDay } = await import("./noticeSequence");
    // 9999-99-99 sorted after every real date and activated a loan on a
    // resolution executed on a day that does not exist.
    for (const bad of ["9999-99-99", "2026-02-30", "2027-13-01", "2026-00-10", "", null, undefined, "21-08-2026"]) {
      expect(isRealIsoDay(bad as never), String(bad)).toBe(false);
    }
  });
});

describe("servicing idempotency (the review findings)", () => {
  const HANDLER = readFileSync(
    resolve(process.cwd(), "amplify/functions/pf-servicing/handler.ts"),
    "utf8"
  );
  /**
   * W7 moved the posting machinery into the shared core so the webhook's
   * autopay postings and hand postings cannot drift apart — the invariants
   * below now live there, and BOTH writers must go through it.
   */
  const POSTING = readFileSync(
    resolve(process.cwd(), "amplify/functions/pfPosting.ts"),
    "utf8"
  );

  it("both writers post through the one shared core", () => {
    expect(HANDLER).toContain('from "../pfPosting"');
    const PF_WEBHOOK = readFileSync(
      resolve(process.cwd(), "amplify/functions/stripe-webhook/pf.ts"),
      "utf8"
    );
    expect(PF_WEBHOOK).toContain('from "../pfPosting"');
    // And neither carries its own ledger WRITE beside the core's — the
    // deterministic-id put with its idempotency condition exists once.
    // (Reading a ledger row by that id, as the duplicate-debit check does,
    // is fine; minting one is not.)
    expect(HANDLER).not.toContain('"attribute_not_exists(id)"');
    expect(PF_WEBHOOK).not.toContain('"attribute_not_exists(id)"');
  });

  it("posts each installment under a deterministic ledger id", () => {
    expect(POSTING).toContain("pf-pay-${loan.id}-${n}");
    expect(POSTING).toContain('ConditionExpression: "attribute_not_exists(id)"');
  });

  it("advances the loan conditionally on paidThrough AND a live status", () => {
    // paidThrough alone let a posting racing a cancellation resurrect a
    // CANCELLED loan to ACTIVE — with a CANCELLATION_REQUEST on file, the
    // carrier cancelling, and no action able to reach the loan again.
    expect(POSTING).toContain(
      '"(paidThrough = :seen OR paidThrough = :n) AND (#s = :active OR #s = :defaulted)"'
    );
    // A lost advance surfaces loudly; the ledger row stands as fact.
    expect(POSTING).toContain("reconcile the loan by hand");
  });

  it("clears defaultedAt by the write, not the read", () => {
    // Dispatching REMOVE on the read status left ACTIVE loans carrying a
    // stale defaultedAt when the sweep raced the posting.
    expect(POSTING).toContain('removes.push("defaultedAt")');
    expect(POSTING).not.toMatch(/loan\.status === "DEFAULTED" && !finished/);
  });

  it("the default sweep marks conditionally — a posting or a claim wins", () => {
    const SWEEP = readFileSync(
      resolve(process.cwd(), "amplify/functions/pf-default-sweep/handler.ts"),
      "utf8"
    );
    // Status and due date pin the state the sweep decided from, and the
    // pending-marker clause re-runs the stand-down at WRITE time: a debit
    // claimed between the scan and the mark must beat the mark, or
    // DEFAULTED coexists with money in flight and the notice sequence can
    // open over it.
    expect(SWEEP).toContain(
      '"#s = :active AND nextDueAt = :seen AND attribute_not_exists(autopayPendingIntentId)"'
    );
    expect(SWEEP).toContain("serviced or claimed mid-sweep");
  });

  it("a duplicate ledger row falls through to reconcile the loan", () => {
    // The second-round finding: returning on the duplicate stranded an
    // orphaned row forever. Now the catch sets a flag instead of returning,
    // the conditional advance re-runs, and the caller hears "reconciled".
    expect(POSTING).toContain("alreadyPosted = true");
    expect(POSTING).not.toContain("is already posted.");
    expect(HANDLER).toContain("loan state reconciled");
  });

  it("runs status transitions conditionally on the status they leave", () => {
    expect(HANDLER).toContain('ConditionExpression: "#s = :from"');
    // W7: ACTIVATE leaves QUOTED or ACCEPTED — whichever the decision read.
    expect(HANDLER).toContain("transition(loan.id, loan.status");
    expect(HANDLER).toContain('loan.status !== "QUOTED" && loan.status !== "ACCEPTED"');
    // DEFAULTED→CANCELLED no longer goes through transition(): it rides a
    // TransactWriteItems with its notice row (pfCancellationNotice.test.ts),
    // carrying the same status condition.
    expect(HANDLER).toContain('":from": "DEFAULTED"');
  });

  it("validates real days on every outside date", () => {
    expect(HANDLER).not.toMatch(/DAY\.test/);
    expect((HANDLER.match(/isRealIsoDay\(/g) ?? []).length).toBe(3);
  });
});

describe("origination rechecks the flag at the last moment", () => {
  it("a disable landing mid-evaluation blocks the create", () => {
    const SRC = readFileSync(
      resolve(process.cwd(), "amplify/functions/pf-originate/handler.ts"),
      "utf8"
    );
    // Stronger than ordering now: the flag check and the loan Put are one
    // TransactWriteItems — no window exists between them at all.
    expect(SRC).toContain("TransactWriteCommand");
    expect(SRC).toContain('ConditionExpression: "premiumFinanceEnabled = :on"');
    expect(SRC).toContain("TransactionCanceledException");
    expect(SRC).not.toContain("client.models.PfLoan.create");
  });
});

describe("a cured default retires its notices", () => {
  it("an old episode's intent cannot authorize this cancellation", () => {
    // Default → intent + cert → cured → re-default: the expired clock from
    // the first episode must not skip the statute's 15 days for the second.
    const redefaultedAt = addDaysIso(T0, 40);
    const v = canRequestCancellation([intent, cert], addDaysIso(T0, 50), redefaultedAt);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("do not carry over");
  });

  it("a fresh intent within the episode still works", () => {
    const redefaultedAt = addDaysIso(T0, 40);
    const fresh: NoticeRow = {
      id: "n9",
      type: "INTENT_TO_CANCEL",
      occurredAt: addDaysIso(T0, 41),
      clockExpiresAt: addDaysIso(T0, 56),
    };
    const freshCert: NoticeRow = {
      id: "n10",
      type: "CERT_OF_MAILING",
      occurredAt: addDaysIso(T0, 42),
      refNoticeId: "n9",
    };
    expect(
      canRequestCancellation([intent, cert, fresh, freshCert], addDaysIso(T0, 57), redefaultedAt).ok
    ).toBe(true);
  });

  it("the handler passes the loan's current defaultedAt", () => {
    const HANDLER = readFileSync(
      resolve(process.cwd(), "amplify/functions/pf-servicing/handler.ts"),
      "utf8"
    );
    expect(HANDLER).toContain("loan.defaultedAt");
    // And activation requires the artifact, not just a typed date.
    expect(HANDLER).toContain("must be on file first");
  });
});
