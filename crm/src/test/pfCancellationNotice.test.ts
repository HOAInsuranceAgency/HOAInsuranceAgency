import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Two servicing invariants from the 2026-08-23 review round, pinned the
 * premiumFinanceFlag.test.ts way.
 *
 * A loan must never be terminally CANCELLED without its CANCELLATION_REQUEST
 * notice row: that row proves the carrier request followed the 15-day clock,
 * PfNotice takes no client writes, and no other action creates the type — a
 * missing row has no supported repair path. So the transition and the row
 * are one TransactWriteItems: both land or neither does.
 *
 * And activation's board-resolution document id must be a real Document on
 * the loan's account, recorded in the compliance row — a pasted-wrong id
 * otherwise activates a lending agreement whose power-of-attorney evidence
 * points at nothing, silently and forever.
 */
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("cancellation and its notice are one write", () => {
  const SERVICING = read("amplify/functions/pf-servicing/handler.ts");

  it("uses a transaction: conditional status flip + notice Put", () => {
    const at = SERVICING.indexOf('"CANCELLATION_REQUEST"');
    expect(at).toBeGreaterThan(-1);
    const branch = SERVICING.slice(at - 3000, at + 500);
    expect(branch).toContain("TransactWriteCommand");
    expect(branch).toContain('ConditionExpression: "#s = :from"');
    expect(branch).toContain('":from": "DEFAULTED"');
    expect(branch).toContain('":to": "CANCELLED"');
    // Stable across the SDK's transport retries, fresh per human attempt.
    expect(branch).toContain("ClientRequestToken: randomUUID()");
  });

  it("claims a lost race only when the status condition actually lost", () => {
    // TransactionCanceledException also covers throttles and conflicts —
    // telling the operator "the loan changed" then fabricates a state
    // change. The mapping keys off the cancellation reason.
    expect(SERVICING).toContain('CancellationReasons?.[0]?.Code === "ConditionalCheckFailed"');
    expect(SERVICING).toContain("nothing changed");
  });

  it("no longer writes the notice as a separate best-effort create", () => {
    // The old shape: transition, then PfNotice.create, then a console.error
    // shrug when the row failed. The shrug string is the tell.
    expect(SERVICING).not.toContain("but its notice row failed");
    // Intent and cert notices still create through the data client — they
    // pair with no terminal transition. The cancellation one must not.
    expect(SERVICING).not.toMatch(
      /PfNotice\.create\(\{[\s\S]{0,200}CANCELLATION_REQUEST/
    );
  });

  it("the notice table is wired with its grant", () => {
    const BACKEND = read("amplify/backend.ts");
    expect(BACKEND).toMatch(/\["PF_NOTICE_TABLE", "PfNotice"\]/);
    // It rides in the loop that calls grantReadWriteData for pfServicing.
    const loop = BACKEND.slice(
      BACKEND.indexOf('["PF_NOTICE_TABLE", "PfNotice"]') - 400,
      BACKEND.indexOf('["PF_NOTICE_TABLE", "PfNotice"]') + 400
    );
    expect(loop).toContain("grantReadWriteData(backend.pfServicing.resources.lambda)");
  });
});

describe("activation checks the resolution document is on file", () => {
  const SERVICING = read("amplify/functions/pf-servicing/handler.ts");

  it("fetches the Document and requires this account's", () => {
    expect(SERVICING).toContain("client.models.Document.get({ id: documentId })");
    expect(SERVICING).toContain("resolutionDoc.entityId !== loan.accountId");
  });

  it("rejects the generated unsigned draft — the likeliest wrong paste", () => {
    // pf-agreement files the draft on the SAME account, named for this very
    // loan; existence + ownership alone would wave it through. The generated
    // categories exist only as pf-agreement output, so either one is
    // provably not an executed scan.
    expect(SERVICING).toContain('resolutionDoc?.category === "PF_BOARD_RESOLUTION"');
    expect(SERVICING).toContain('resolutionDoc?.category === "PF_AGREEMENT"');
    expect(SERVICING).toContain("the generated draft, not an executed resolution");
  });

  it("a failed lookup is not a missing document", () => {
    // A resolver throttle must not write a permanent BLOCK row asserting
    // "not on file" about a registry that merely didn't answer.
    expect(SERVICING).toMatch(/docErrs\?\.length/);
    expect(SERVICING).toContain("Couldn't look up that document. Try again.");
  });

  it("records the attested id in the compliance rows, pass and block", () => {
    // The BLOCK for a missing/foreign document names the id…
    expect(SERVICING).toMatch(/rule: "board-resolution"[\s\S]{0,400}inputs: \{ loanId: loan\.id, documentId \}/);
    // …and the staleness PASS/BLOCK row carries it too.
    expect(SERVICING).toContain("inputs: { loanId: loan.id, executed, termStart, documentId }");
  });
});
