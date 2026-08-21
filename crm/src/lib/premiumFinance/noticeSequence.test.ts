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

  it("posting refuses without a designated lending account", () => {
    expect(HANDLER).toContain("pfLendingAccountName");
    expect(HANDLER).toContain("must not touch the premium trust");
  });

  it("the split comes from the frozen schedule, not from arithmetic here", () => {
    expect(HANDLER).toContain("interest: row.interest");
    expect(HANDLER).toContain("principal: row.principal");
  });
});
