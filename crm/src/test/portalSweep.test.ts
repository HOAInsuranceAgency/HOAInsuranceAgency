import { describe, expect, it } from "vitest";
import {
  OCR_PATIENCE_MINUTES,
  QUIET_MINUTES,
  decideSweep,
  type DocumentRow,
} from "../../amplify/functions/portal-sweep/decide";
import {
  arrivedSections,
  renderNotification,
  totalArrived,
} from "../../amplify/functions/portal-sweep/email";
import { extractedAt, parseStoredJson } from "../lib/aiExtraction";
import { isExtractableCategory } from "../lib/enums";
import { REQUESTED_DOCUMENTS } from "../../../shared/leadDocuments";

/**
 * The rule that decides whether anyone hears about a lead's uploaded documents.
 *
 * The failure that matters is silence: an upload nobody is told about looks
 * exactly like no upload. So every wait branch below is asserted to be bounded
 * by something that must eventually resolve.
 */

const NOW = "2026-08-20T18:00:00.000Z";
const minsBefore = (n: number) =>
  new Date(Date.parse(NOW) - n * 60_000).toISOString();

const base = {
  now: NOW,
  isExtractable: isExtractableCategory,
  documents: [] as DocumentRow[],
  account: { extractionStatus: null, extractedAt: null },
};

const portal = (over: Partial<Parameters<typeof decideSweep>[0]["portal"]> = {}) => ({
  id: "p1",
  accountId: "acct-1",
  lastUploadAt: minsBefore(QUIET_MINUTES + 1),
  notifiedUpTo: null,
  ...over,
});

const doc = (over: Partial<DocumentRow> = {}): DocumentRow => ({
  ocrStatus: "COMPLETE",
  category: "LOSS_RUNS",
  createdAt: minsBefore(QUIET_MINUTES + 2),
  ...over,
});

describe("when the team is told about an upload", () => {
  it("says nothing about a portal that has received nothing", () => {
    const d = decideSweep({ ...base, portal: portal({ lastUploadAt: null }) });
    expect(d.action).toBe("wait");
  });

  it("says nothing twice about the same batch", () => {
    const at = minsBefore(30);
    const d = decideSweep({
      ...base,
      portal: portal({ lastUploadAt: at, notifiedUpTo: at }),
    });
    expect(d).toEqual({ action: "wait", reason: "already notified for this batch" });
  });

  it("waits while they are still uploading", () => {
    const d = decideSweep({
      ...base,
      portal: portal({ lastUploadAt: minsBefore(QUIET_MINUTES - 1) }),
    });
    expect(d.action).toBe("wait");
    expect(d).toHaveProperty("reason", expect.stringContaining("still uploading"));
  });

  it("sends once they have been quiet, with nothing extractable to wait for", () => {
    const d = decideSweep({
      ...base,
      portal: portal(),
      documents: [doc({ category: "BUDGET" })],
    });
    expect(d.action).toBe("notify");
  });

  /**
   * The bug this shape prevents: marking the batch done with `now` would
   * swallow a file that landed while the email was being built.
   */
  it("marks the batch at the upload it decided on, not at the moment it sent", () => {
    const at = minsBefore(QUIET_MINUTES + 5);
    const d = decideSweep({
      ...base,
      portal: portal({ lastUploadAt: at }),
      documents: [doc({ category: "BUDGET" })],
    });
    expect(d).toMatchObject({ action: "notify", upTo: at });
    expect(d).not.toMatchObject({ upTo: NOW });
  });

  it("carries the previous mark, so the email covers only what is new", () => {
    const since = minsBefore(120);
    const d = decideSweep({
      ...base,
      portal: portal({ notifiedUpTo: since }),
      documents: [doc({ category: "BUDGET" })],
    });
    expect(d).toMatchObject({ action: "notify", since });
  });
});

describe("waiting for OCR", () => {
  it("holds while a readable document is still being processed", () => {
    const d = decideSweep({
      ...base,
      portal: portal(),
      documents: [doc({ ocrStatus: "PENDING" })],
    });
    expect(d).toMatchObject({ action: "wait" });
    expect(d).toHaveProperty("reason", expect.stringContaining("OCR"));
  });

  it("does not hold for a document nothing was ever going to read", () => {
    // A budget is attached and useful and will never be fed to a model, so
    // waiting on its OCR would delay the email for nothing.
    const d = decideSweep({
      ...base,
      portal: portal(),
      documents: [doc({ category: "BUDGET", ocrStatus: "PENDING" })],
    });
    expect(d.action).toBe("notify");
  });

  it("gives up on a wedged document rather than going silent forever", () => {
    // The branch that makes "wait for OCR" bounded. Without it, one stuck
    // document suppresses the notification for every file beside it.
    const d = decideSweep({
      ...base,
      portal: portal({ lastUploadAt: minsBefore(OCR_PATIENCE_MINUTES + 1) }),
      documents: [doc({ ocrStatus: "PROCESSING" })],
    });
    expect(d.action).toBe("notify");
  });

  it("treats a failed OCR as finished, not as pending", () => {
    const d = decideSweep({
      ...base,
      portal: portal(),
      documents: [doc({ ocrStatus: "FAILED" })],
    });
    expect(d.action).toBe("notify");
  });
});

describe("running extraction before telling anyone", () => {
  it("extracts when readable documents are newer than the last extraction", () => {
    const d = decideSweep({
      ...base,
      portal: portal(),
      documents: [doc()],
      account: { extractionStatus: "COMPLETE", extractedAt: minsBefore(600) },
    });
    expect(d.action).toBe("extract");
  });

  it("extracts when the account has never been extracted", () => {
    const d = decideSweep({ ...base, portal: portal(), documents: [doc()] });
    expect(d.action).toBe("extract");
  });

  it("waits while extraction is running rather than starting a second one", () => {
    for (const status of ["PENDING", "PROCESSING"]) {
      const d = decideSweep({
        ...base,
        portal: portal(),
        documents: [doc()],
        account: { extractionStatus: status, extractedAt: null },
      });
      expect(d, status).toMatchObject({ action: "wait" });
    }
  });

  it("sends once extraction covers the new documents", () => {
    const at = minsBefore(QUIET_MINUTES + 1);
    const d = decideSweep({
      ...base,
      portal: portal({ lastUploadAt: at }),
      documents: [doc()],
      account: { extractionStatus: "COMPLETE", extractedAt: minsBefore(1) },
    });
    expect(d.action).toBe("notify");
  });

  /**
   * A COMPLETE run from the original auto-reply says nothing about files
   * uploaded three weeks later, which is exactly the gap this sweep closes.
   */
  it("does not mistake an old completed extraction for coverage", () => {
    const d = decideSweep({
      ...base,
      portal: portal({ lastUploadAt: minsBefore(QUIET_MINUTES + 1) }),
      documents: [doc()],
      account: { extractionStatus: "COMPLETE", extractedAt: minsBefore(60 * 24 * 21) },
    });
    expect(d.action).toBe("extract");
  });

  it("sends anyway when extraction failed, rather than never sending", () => {
    // FAILED is terminal, so the coverage check decides. An unreadable
    // `extractedAt` re-runs once; a genuinely failed run must not loop forever,
    // which is what the status check above guarantees.
    const d = decideSweep({
      ...base,
      portal: portal(),
      documents: [doc({ category: "BUDGET" })],
      account: { extractionStatus: "FAILED", extractedAt: null },
    });
    expect(d.action).toBe("notify");
  });

  it("never waits on an unparseable timestamp", () => {
    // A spurious email beats a silent one.
    const d = decideSweep({ ...base, portal: portal({ lastUploadAt: "not a date" }) });
    expect(d.action).toBe("notify");
  });
});

describe("what the email says", () => {
  it("groups the batch in checklist order, not arrival order", () => {
    const sections = arrivedSections([
      { category: "BUDGET" },
      { category: "PRIOR_POLICY" },
      { category: "LOSS_RUNS" },
      { category: "LOSS_RUNS" },
    ]);
    // REQUESTED_DOCUMENTS order: policies, renewal, loss runs, values, budget…
    expect(sections.map((s) => s.label)).toEqual([
      "Current policies",
      "Loss runs",
      "Current association budget",
    ]);
    expect(sections.find((s) => s.label === "Loss runs")?.count).toBe(2);
    expect(totalArrived(sections)).toBe(4);
  });

  it("ignores documents that answer no question on the list", () => {
    expect(arrivedSections([{ category: "ACORD_FORM" }, { category: null }])).toEqual(
      []
    );
  });

  it("names the association in the subject, for a shared mailbox", () => {
    const { subject } = renderNotification({
      associationName: "Robin Hollow Condominium Trust",
      accountId: "acct-1",
      arrived: [{ label: "Loss runs", count: 3 }],
      extracted: {},
      outstanding: [],
      crmBaseUrl: "https://app.protectmyhoa.com",
    });
    expect(subject).toContain("Robin Hollow Condominium Trust");
    expect(subject).toContain("3 documents");
  });

  it("says one document, not one documents", () => {
    const { subject } = renderNotification({
      associationName: "A",
      accountId: "x",
      arrived: [{ label: "Loss runs", count: 1 }],
      extracted: {},
      outstanding: [],
      crmBaseUrl: "https://app.protectmyhoa.com",
    });
    expect(subject).toContain("1 document received");
  });

  it("links straight to the account, with no double slash", () => {
    for (const baseUrl of ["https://app.protectmyhoa.com", "https://app.protectmyhoa.com/"]) {
      const { text, html } = renderNotification({
        associationName: "A",
        accountId: "acct-7",
        arrived: [{ label: "Loss runs", count: 1 }],
        extracted: {},
        outstanding: [],
        crmBaseUrl: baseUrl,
      });
      expect(text).toContain("https://app.protectmyhoa.com/accounts/acct-7");
      expect(html).toContain("https://app.protectmyhoa.com/accounts/acct-7");
    }
  });

  it("reports what extraction read, humanised", () => {
    const { text, html } = renderNotification({
      associationName: "A",
      accountId: "x",
      arrived: [{ label: "Loss runs", count: 2 }],
      extracted: { currentCarrier: "Acadia", masterPolicyExpiration: "2026-09-30" },
      outstanding: ["Current association budget"],
      crmBaseUrl: "https://app.protectmyhoa.com",
    });
    expect(text).toContain("Current carrier: Acadia");
    expect(html).toContain("Acadia");
    expect(text).toContain("Still outstanding: Current association budget.");
  });

  it("says so plainly when nothing could be read", () => {
    const { text } = renderNotification({
      associationName: "A",
      accountId: "x",
      arrived: [{ label: "Governing documents", count: 1 }],
      extracted: {},
      outstanding: [],
      crmBaseUrl: "https://app.protectmyhoa.com",
    });
    expect(text).toMatch(/nothing could be read/i);
    expect(text).toMatch(/completes the list/i);
  });

  it("escapes markup in an association's name", () => {
    const { html } = renderNotification({
      associationName: '<script>alert(1)</script>',
      accountId: "x",
      arrived: [{ label: "Loss runs", count: 1 }],
      extracted: {},
      outstanding: [],
      crmBaseUrl: "https://app.protectmyhoa.com",
    });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("declares a charset", () => {
    const { html } = renderNotification({
      associationName: "Côte Village",
      accountId: "x",
      arrived: [{ label: "Loss runs", count: 1 }],
      extracted: {},
      outstanding: [],
      crmBaseUrl: "https://app.protectmyhoa.com",
    });
    expect(html).toContain('<meta charset="utf-8">');
  });

  it("can name every checklist section as outstanding", () => {
    // Guards the label strings against drifting from shared/leadDocuments.ts.
    const labels = REQUESTED_DOCUMENTS.map((r) => r.label);
    const { text } = renderNotification({
      associationName: "A",
      accountId: "x",
      arrived: [{ label: "Loss runs", count: 1 }],
      extracted: {},
      outstanding: labels,
      crmBaseUrl: "https://app.protectmyhoa.com",
    });
    for (const label of labels) expect(text).toContain(label);
  });
});

describe("reading a stored extraction", () => {
  const stored = JSON.stringify({
    currentCarrier: { value: "Acadia", confidence: "high" },
    extractedAt: "2026-08-20T15:35:32.000Z",
  });

  it("parses one and two levels of stringify", () => {
    expect(parseStoredJson(stored)?.extractedAt).toBe("2026-08-20T15:35:32.000Z");
    expect(parseStoredJson(JSON.stringify(stored))?.extractedAt).toBe(
      "2026-08-20T15:35:32.000Z"
    );
  });

  it("reads the run's timestamp, which is what coverage is decided on", () => {
    expect(extractedAt(stored)).toBe("2026-08-20T15:35:32.000Z");
  });

  it("reads null for anything unusable, so the sweep extracts again", () => {
    // The safe direction: re-running costs a model call, skipping wrongly means
    // documents someone just sent are never read.
    for (const bad of [null, undefined, "", "not json", "[]", JSON.stringify({}), 7]) {
      expect(extractedAt(bad)).toBeNull();
    }
  });

  it("does not mistake an array for a result object", () => {
    expect(parseStoredJson(JSON.stringify([1, 2]))).toBeNull();
  });
});
