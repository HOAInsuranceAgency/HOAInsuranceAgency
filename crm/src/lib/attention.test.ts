import { describe, expect, it } from "vitest";
import { buildAttentionQueue, type AttentionInputs } from "./attention";

/**
 * The queue's job is selection and ranking; the tests pin both. A fixed
 * clock and a linear daysUntil keep every rule deterministic.
 */
const NOW = new Date("2026-08-24T12:00:00Z");
const days = (d: string) =>
  Math.round((Date.parse(`${d.slice(0, 10)}T12:00:00Z`) - NOW.getTime()) / 86_400_000);

const EMPTY: AttentionInputs = {
  accountNames: new Map(),
  quotes: [],
  invoices: [],
  loans: [],
  renewals: [],
  tasks: [],
  failedDocs: [],
  accountsWithFailedExtraction: [],
  licenses: [],
};

function queue(partial: Partial<AttentionInputs>) {
  return buildAttentionQueue({ ...EMPTY, ...partial }, days, NOW);
}

describe("buildAttentionQueue", () => {
  it("an empty world needs no attention", () => {
    expect(queue({})).toEqual([]);
  });

  it("flags only overdue open invoices, with the link's amount in dollars", () => {
    const items = queue({
      accountNames: new Map([["a1", "Harbor Pointe COA"]]),
      invoices: [
        { accountId: "a1", number: "INV-1", status: "SENT", dueAt: "2026-08-12", stripeLinkAmountCents: 1845000 },
        { accountId: "a1", number: "INV-2", status: "SENT", dueAt: "2026-09-12", stripeLinkAmountCents: 100 },
        { accountId: "a1", number: "INV-3", status: "PAID", dueAt: "2026-08-01", stripeLinkAmountCents: 100 },
        { accountId: "a1", number: "INV-4", status: "DRAFT", dueAt: "2026-08-01", stripeLinkAmountCents: 100 },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "invoice-overdue",
      severity: "red",
      overdueDays: 12,
      amount: 18450,
      accountName: "Harbor Pointe COA",
    });
  });

  it("a defaulted loan is red; a live pending election is blue; an expired election token is nothing", () => {
    const items = queue({
      accountNames: new Map([["a1", "Stonebridge"], ["a2", "Cypress"], ["a3", "Elm"]]),
      loans: [
        { accountId: "a1", status: "DEFAULTED", balance: 31082, autopayFailedInstallment: 4, defaultedAt: "2026-08-19T00:00:00Z" },
        { accountId: "a2", status: "QUOTED", electionToken: "tok", quotedAt: "2026-08-18T12:00:00Z", electionTokenExpiresAt: "2026-09-01T12:00:00Z" },
        { accountId: "a3", status: "QUOTED", electionToken: "tok2", electionTokenExpiresAt: "2026-08-01T00:00:00Z" },
      ],
    });
    expect(items.map((i) => i.kind)).toEqual(["loan-defaulted", "election-pending"]);
    expect(items[0]).toMatchObject({ severity: "red", outstanding: 31082, failedInstallment: 4 });
    expect(items[1]).toMatchObject({ severity: "blue", pendingDays: 6, expiresInDays: 8 });
  });

  it("a near renewal with neither tasks nor quotes is flagged; either one clears it", () => {
    const items = queue({
      renewals: [
        { accountId: "a1", name: "Willow Creek", date: "2026-09-11", days: 18, premium: 42800 },
        { accountId: "a2", name: "Tasked HOA", date: "2026-09-11", days: 18, premium: 10000 },
        { accountId: "a3", name: "Far Off HOA", date: "2026-11-24", days: 92, premium: 5000 },
        // The sweep never creates a task for an already-quoted carrier, so
        // a quote in the window must count as marketing started.
        { accountId: "a4", name: "Quoted Early HOA", date: "2026-09-11", days: 18, premium: 7000 },
      ],
      tasks: [{ accountId: "a2", expirationDate: "2026-09-11", status: "COMPLETE" }],
      quotes: [{ accountId: "a4", createdAt: "2026-08-01T09:00:00Z" }],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "renewal-unmarketed", accountName: "Willow Creek", days: 18 });
  });

  it("an unmarketed renewal past its date turns red instead of vanishing", () => {
    const items = queue({
      renewals: [
        { accountId: "a1", name: "Lapsed HOA", date: "2026-08-20", days: -4, premium: 20000 },
        { accountId: "a2", name: "Ancient HOA", date: "2026-01-01", days: -235, premium: 1 },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "renewal-unmarketed", severity: "red", days: -4 });
  });

  it("an open task past submit-by is flagged with the denormalized names", () => {
    const items = queue({
      tasks: [
        { accountId: "a1", accountName: "Bayview", carrierName: "Meridian", submitBy: "2026-08-21", status: "OPEN" },
        { accountId: "a1", accountName: "Bayview", carrierName: "Lakeshore", submitBy: "2026-09-05", status: "OPEN" },
        { accountId: "a1", accountName: "Bayview", carrierName: "Old", submitBy: "2026-08-01", status: "COMPLETE" },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "task-window-missed", carrierName: "Meridian", daysPast: 3 });
  });

  it("OCR and AI-extraction failures are separate items — one pipeline must not hide the other", () => {
    const items = queue({
      accountNames: new Map([["a1", "Mill Run"]]),
      failedDocs: [
        { entityType: "ACCOUNT", entityId: "a1", name: "declarations.pdf" },
        { entityType: "ACCOUNT", entityId: "a1", name: "budget.pdf" }, // same account's docs dedupe
        { entityType: "LICENSE", entityId: "x", name: "not-an-account.pdf" },
      ],
      accountsWithFailedExtraction: [
        { id: "a1", name: "Mill Run" },
        { id: "a2", name: "Foxglove" },
      ],
    });
    expect(
      items.map(
        (i) =>
          i.kind === "extraction-failed" && [i.pipeline, i.accountName, i.documentName]
      )
    ).toEqual([
      ["ocr", "Mill Run", "declarations.pdf"],
      ["extraction", "Mill Run", null],
      ["extraction", "Foxglove", null],
    ]);
  });

  it("licenses grade by distance — expired red, a month amber, two months blue — and dead rows are records, not deadlines", () => {
    const items = queue({
      licenses: [
        { holderType: "FIRM", state: "FL", status: "ACTIVE", expirationDate: "2026-10-05" }, // 42d
        { holderType: "PRODUCER", holderName: "Jake Greasley", state: "MA", status: "ACTIVE", expirationDate: "2026-09-10" }, // 17d
        { holderType: "FIRM", state: "RI", status: "ACTIVE", expirationDate: "2026-08-20" }, // -4d
        { holderType: "FIRM", state: "TX", status: "LAPSED", expirationDate: "2026-08-01" },
        { holderType: "FIRM", state: "VT", status: "ACTIVE", expirationDate: "2026-12-01" }, // beyond horizon
      ],
    });
    expect(items.map((i) => [i.severity, i.kind === "license-expiring" && i.state])).toEqual([
      ["red", "RI"],
      ["amber", "MA"],
      ["blue", "FL"],
    ]);
    expect(items[1]).toMatchObject({ holder: "Jake Greasley" });
  });

  it("ranks red before amber before blue, and more-overdue before less within a severity", () => {
    const items = queue({
      accountNames: new Map([["a1", "A"], ["a2", "B"]]),
      invoices: [
        { accountId: "a1", status: "SENT", dueAt: "2026-08-20", stripeLinkAmountCents: 100 }, // 4d overdue
        { accountId: "a2", status: "SENT", dueAt: "2026-08-12", stripeLinkAmountCents: 100 }, // 12d overdue
      ],
      renewals: [{ accountId: "a1", name: "A", date: "2026-09-11", days: 18, premium: null }],
      loans: [{ accountId: "a2", status: "QUOTED", electionToken: "t", quotedAt: "2026-08-18T12:00:00Z" }],
    });
    expect(items.map((i) => i.kind)).toEqual([
      "invoice-overdue", // 12d
      "invoice-overdue", // 4d
      "renewal-unmarketed",
      "election-pending",
    ]);
    expect(items[0]).toMatchObject({ overdueDays: 12 });
  });
});
