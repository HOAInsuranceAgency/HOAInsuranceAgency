import { describe, expect, it } from "vitest";
import { buildMarketingLeadReport, MARKETING_REPORT_HEADERS, type ReportRecord, type ReportSnapshot } from "../../../shared/marketingLeadReport";

const now = "2026-09-28T12:00:00.000Z";
function snapshot(overrides: Partial<ReportSnapshot> = {}): ReportSnapshot {
  return { accounts: [{ id: "a", name: "Test association", stage: "LEAD", type: "ASSOCIATION", createdAt: "2026-09-01T12:00:00Z" }], quotes: [], policies: [], priorCarriers: [], carriers: [], documents: [], activities: [], workflows: [], communications: [], tasks: [], submissions: [], ...overrides };
}
function values(input: Partial<ReportSnapshot>, asOf = now) {
  const report = buildMarketingLeadReport(snapshot(input), asOf);
  return Object.fromEntries(report.headers.map((h, i) => [h, report.rows[0][i]]));
}
function comm(id: string, direction: string, at: string, overrides: ReportRecord = {}): ReportRecord {
  return { id, accountId: "a", channel: "EMAIL", purpose: "PROSPECT", direction, at, conversationId: "conversation-a", classification: "SUBSTANTIVE", status: direction === "INBOUND" ? "RECEIVED" : "SENT", text: "A human message", ...overrides };
}
const date = (day: string) => new Date(`${day}T00:00:00Z`);

describe("weekly marketing report truth and template contract", () => {
  it("preserves the updated 53-column layout, stable IDs and bound clients without importing historical template rows", () => {
    const result = buildMarketingLeadReport(snapshot({ accounts: [
      { id: "client", name: "Converted", stage: "CLIENT" }, { id: "lead", name: "Open", stage: "LEAD" },
      { id: "future", name: "Future", stage: "LEAD", createdAt: "2026-10-01T12:00:00Z" },
    ] }), now);
    expect(result.headers).toHaveLength(53);
    expect(result.headers.slice(0, 6)).toEqual(["Lead ID", "Lead Name", "State", "Property Type", "Property Units", "Status"]);
    expect(result.headers.slice(18, 28)).toEqual(["Inquiry Date", "First Agency Contact Date", "First Client Reply Date", "Docs First Received Date", "Quote Issued Date", "Bound Date", "Lost Date", "Last Client Response Date", "Last Client Response Note", "Last Agency Outbound Date"]);
    expect(result.headers.slice(47)).toEqual(["Lead Age (Days)", "Days to Last Client Response", "Days Since Last Client Response", "Days Since Last Agency Outbound", "Stalled", "Notes"]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every(r => r.length === 53)).toBe(true);
    expect(result.rows[0][0]).toBe("client");
    expect(result.rows[0][5]).toBe("BOUND");
  });

  it("reports recorded property categories and unit counts for leads and converted clients", () => {
    const accounts = [
      { id: "hoa", name: "A", stage: "LEAD", type: "ASSOCIATION", propertyType: "HOA_POA_POND_TOWNHOME", unitCount: 48 },
      { id: "condo", name: "B", stage: "CLIENT", type: "ASSOCIATION", propertyType: "CONDO", unitCount: 12 },
      { id: "owner", name: "C", stage: "LEAD", type: "PERSONAL" },
    ];
    const report = buildMarketingLeadReport(snapshot({ accounts }), now);
    expect(report.rows.map(row => row.slice(3, 5))).toEqual([
      ["HOA / POA / pond / townhome HOA", 48], ["CONDO", 12], ["Individual unit owner", null],
    ]);
  });

  it("uses explicit historical intake answers without guessing from names or unrelated accounts", () => {
    const accounts = [{ id: "a", name: "Pond View Townhome Condominium", stage: "LEAD", type: "ASSOCIATION" }];
    expect(values({ accounts })["Property Type"]).toBe("Not recorded");
    for (const propertyKind of ["unknown", "", "townhouse", undefined]) {
      expect(values({ accounts, submissions: [{ accountId: "a", createdAt: "2026-09-01", propertyKind }] })["Property Type"]).toBe("Not recorded");
    }
    const intake = { accountId: "a", createdAt: "2026-09-01", propertyKind: "condominium" };
    expect(values({ accounts, submissions: [intake] })["Property Type"]).toBe("CONDO");
    expect(values({ accounts, submissions: [{ ...intake, propertyKind: undefined, answerPropertyKind: "other" }] })["Property Type"]).toBe("HOA / POA / pond / townhome HOA");
    for (const patch of [{ accountId: "other" }, { createdAt: "2026-10-01" }, { createdAt: undefined }]) {
      expect(values({ accounts, submissions: [{ ...intake, ...patch }] })["Property Type"]).toBe("Not recorded");
    }
    const conflict = values({ accounts, submissions: [intake, { ...intake, propertyKind: "other" }] });
    expect(conflict["Property Type"]).toBe("Not recorded");
    expect(conflict.Notes).toContain("Conflicting website property types");
    expect(values({ accounts, submissions: [{ ...intake, answerPropertyKind: "other" }] })["Property Type"]).toBe("Not recorded");
    expect(values({ accounts: [{ ...accounts[0], propertyType: "HOA_POA_POND_TOWNHOME" }], submissions: [intake] })["Property Type"]).toBe("HOA / POA / pond / townhome HOA");
  });

  it("honors an explicit Not recorded choice over historical intake and personal-account fallback", () => {
    for (const type of ["ASSOCIATION", "PERSONAL"]) {
      const row = values({ accounts: [{ id: "a", stage: "LEAD", type, propertyType: "NOT_RECORDED" }], submissions: [{ accountId: "a", createdAt: "2026-09-01", propertyKind: "condominium" }] });
      expect(row["Property Type"]).toBe("Not recorded");
    }
  });

  it("keeps missing or invalid unit counts blank and retains recorded zero without inferring one for owners", () => {
    for (const unitCount of [undefined, null, "12", -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(values({ accounts: [{ id: "a", stage: "LEAD", type: "PERSONAL", unitNumber: "12", unitCount }] })["Property Units"]).toBeNull();
    }
    expect(values({ accounts: [{ id: "a", stage: "LEAD", unitCount: 0 }] })["Property Units"]).toBe(0);
  });

  it("leaves absent judgments, dates and amounts unknown, including zero outreach", () => {
    const row = values({});
    for (const column of ["Quote Amount ($)", "Premium on Record ($)", "First Agency Contact Date", "First Client Reply Date", "Quote Issued Date", "Days Since Last Agency Outbound"]) expect(row[column]).toBeNull();
    for (const column of ["Excluded", "Quote Lead", "In Incumbent Average", "Docs Received", "Stalled", "Attribution Confidence"]) expect(row[column]).toBe("Not recorded");
    expect(row["Lead Age (Days)"]).toBe(27);
  });

  it("ignores retired tasks when reporting current status, holds and outstanding documents", () => {
    const current = { communications: [comm("reply", "INBOUND", "2026-09-25T12:00:00Z")] };
    const withoutTasks = values(current);
    const withTasks = values({ ...current, tasks: [
      { id: "held", accountId: "a", status: "OPEN", kind: "DOCUMENTS", title: "Missing documents", createdAt: "2026-09-01", dueAt: "2026-09-02", blocker: { state: "BLOCKED", reason: "Old blocker" } },
      { id: "overdue", accountId: "a", status: "OPEN", kind: "FIRST_CONTACT", createdAt: "2026-09-01", dueAt: "2026-09-02" },
    ] });
    expect(withTasks).toEqual(withoutTasks);
    expect(withTasks["Docs Outstanding"]).toBe("Not recorded");
    expect(withTasks["Hold Reason"]).toBe("Not recorded");
  });

  it("does not turn the untagged organic-website default into verified organic search", () => {
    const row = values({ accounts: [{ id: "a", stage: "LEAD", leadSource: "ORGANIC_WEBSITE", source: "website-quote" }] });
    expect(row.Channel).toBe("Not recorded");
    expect(row["Paid Source"]).toBe("Not recorded");
    expect(row["Attribution Confidence"]).toBe("Low");
    const tagged = values({ accounts: [{ id: "a", stage: "LEAD", source: "website-quote", leadAttribution: JSON.stringify({ gclid: "recorded-click" }) }] });
    expect(tagged.Channel).toBe("Paid Search");
    expect(tagged["Paid Source"]).toBe("Y");
  });

  it("separates the initial inquiry from a later reply and ignores nonhuman, failed, wrong-number, carrier and future activity", () => {
    const row = values({ communications: [
      comm("inquiry", "INBOUND", "2026-09-01T12:01:00Z"),
      comm("welcome", "OUTBOUND", "2026-09-01T12:02:00Z", { actorId: "crm:initial-ai" }),
      comm("carrier", "OUTBOUND", "2026-09-01T13:00:00Z", { purpose: "CARRIER" }),
      comm("draft", "OUTBOUND", "2026-09-02T12:00:00Z", { frontDraft: true }),
      comm("failed", "OUTBOUND", "2026-09-03T12:00:00Z", { status: "FAILED" }),
      comm("wrong", "OUTBOUND", "2026-09-03T13:00:00Z", { outcome: "WRONG_NUMBER" }),
      comm("first", "OUTBOUND", "2026-09-04T12:00:00Z"),
      comm("reply", "INBOUND", "2026-09-05T12:00:00Z", { summary: "Please see https://portal.example/?token=secret for documents" }),
      comm("auto", "INBOUND", "2026-09-06T12:00:00Z", { classification: "AUTOMATIC" }),
      comm("report", "OUTBOUND", "2026-09-07T12:00:00Z", { internalReport: true }),
      comm("future", "INBOUND", "2026-10-01T12:00:00Z"),
    ] });
    expect(row["Inquiry Date"]).toEqual(date("2026-09-01"));
    expect(row["First Agency Contact Date"]).toEqual(date("2026-09-04"));
    expect(row["First Client Reply Date"]).toEqual(date("2026-09-05"));
    expect(row["Last Client Response Date"]).toEqual(date("2026-09-05"));
    expect(row["Days to Last Client Response"]).toBe(4);
    expect(row["Last Client Response Note"]).not.toContain("secret");
  });

  it("requires two unanswered contacts and seven full days for dropped off while leaving the separate editorial Stalled field unknown", () => {
    const communications = [comm("first", "OUTBOUND", "2026-09-02T12:00:00Z"), comm("reply", "INBOUND", "2026-09-03T12:00:00Z"), comm("f1", "OUTBOUND", "2026-09-20T12:00:00Z"), comm("f2", "OUTBOUND", "2026-09-21T12:00:00Z")];
    expect(values({ communications }, "2026-09-28T11:59:59Z").Status).not.toBe("DROPPED OFF");
    expect(values({ communications }).Stalled).toBe("Not recorded");
    expect(values({ communications }).Status).toBe("DROPPED OFF");
    expect(values({ communications: [...communications, comm("answered", "INBOUND", "2026-09-25T12:00:00Z")] }).Stalled).toBe("Not recorded");
    expect(values({ communications: communications.map(c => c.id === "f2" ? { ...c, conversationId: "other" } : c) }).Stalled).toBe("Not recorded");
    expect(values({ communications: communications.filter(c => c.id !== "reply") }).Status).toBe("NO RESPONSE");
  });

  it("selects one latest presented quote for date, carrier and premium; carrier-ready quotes are not issued", () => {
    const quotes = [
      { id: "old", accountId: "a", status: "PRESENTED", presentedAt: "2026-09-10T12:00:00Z", premium: 100, carrierId: "old", lines: ["Commercial Property"] },
      { id: "new", accountId: "a", status: "PRESENTED", presentedAt: "2026-09-20T12:00:00Z", premium: 0, carrierId: "new", lines: ["General Liability"] },
      { id: "ready", accountId: "a", status: "QUOTED", readyAt: "2026-09-25T12:00:00Z", premium: 500, carrierId: "ready" },
      { id: "future", accountId: "a", status: "PRESENTED", presentedAt: "2026-10-01T12:00:00Z", premium: 1000 },
    ];
    const row = values({ quotes, carriers: [{ id: "new", name: "New carrier" }] });
    expect(row["Quote Issued"]).toBe("Y");
    expect(row["Quote Issued Date"]).toEqual(date("2026-09-20"));
    expect(row["Quote Carrier"]).toBe("New carrier");
    expect(row["Quote Amount ($)"]).toBe(0);
    expect(row["Premium Category"]).toBe("Agency Quote");
    expect(row["Coverage Requested"]).toBe("Not recorded");
    expect(row["Coverage Segment"]).not.toContain("only");
    expect(values({ quotes: [quotes[2]] })["Quote Issued"]).toBe("Not recorded");
  });

  it("retains issued truth when its date is missing without guessing which undated quote is latest", () => {
    const quotes = [{ id: "one", accountId: "a", status: "PRESENTED", premium: 100 }];
    expect(values({ quotes })["Quote Issued"]).toBe("Y");
    expect(values({ quotes })["Quote Issued Date"]).toBeNull();
    expect(values({ quotes })["Quote Amount ($)"]).toBe(100);
    const ambiguous = values({ quotes: [...quotes, { id: "two", accountId: "a", status: "PRESENTED", premium: 200, presentedAt: "2026-09-20T12:00:00Z" }] });
    expect(ambiguous["Quote Amount ($)"]).toBeNull();
    expect(ambiguous.Notes).toContain("selection needs review");
  });

  it("keeps incumbent, agency and bound premiums separate and never guesses incumbent-average eligibility", () => {
    const priorCarriers = [{ accountId: "a", carrierName: "Incumbent", premium: 1000, lineOfBusiness: "Commercial Property", effectiveDate: "2026-01-01", expirationDate: "2027-01-01" }];
    const prior = values({ priorCarriers });
    expect(prior["Premium on Record ($)"]).toBe(1000);
    expect(prior["Premium Category"]).toBe("Prior policy; status unverified");
    expect(prior["In Incumbent Average"]).toBe("Not recorded");
    const bound = values({ accounts: [{ id: "a", stage: "CLIENT" }], priorCarriers, policies: [{ accountId: "a", status: "ACTIVE", premium: 800, effectiveDate: "2026-07-01", expirationDate: "2027-07-01", datePolicyBound: "2026-06-29" }], quotes: [{ id: "q", accountId: "a", status: "BOUND", premium: 900 }] });
    expect(bound["Premium on Record ($)"]).toBe(800);
    expect(bound["Premium Category"]).toBe("Bound Policy");
    expect(bound["Quote Amount ($)"]).toBe(900);
    expect(bound["Other Premium on Record"]).toContain("1000.00");
    expect(bound["Bound Date"]).toEqual(date("2026-06-29"));
    expect(bound["Policy Expiration Date"]).toEqual(date("2027-07-01"));
    const expired = values({ priorCarriers: [{ ...priorCarriers[0], expirationDate: "2026-01-01" }] });
    expect(expired["Premium on Record ($)"]).toBeNull();
    expect(expired["Policy Expiration Date"]).toBeNull();
  });

  it("counts received prospect documents without counting generated agency quotes or signature images", () => {
    const row = values({ documents: [
      { entityId: "a", entityType: "ACCOUNT", name: "Bylaws.pdf", s3Key: "uploaded", lastWriteBy: "upload-portal", createdAt: "2026-09-04T12:00:00Z" },
      { entityId: "a", entityType: "ACCOUNT", name: "Agency quote.pdf", s3Key: "generated", category: "QUOTE_DOC", quoteId: "q", createdAt: "2026-09-01T12:00:00Z" },
      { entityId: "a", entityType: "ACCOUNT", name: "Unverified.pdf", s3Key: "staff-upload", category: "PRIOR_POLICY", createdAt: "2026-09-01T12:00:00Z" },
    ], communications: [comm("in", "INBOUND", "2026-09-02T12:00:00Z", { attachments: [{ filename: "signature.png" }] })] });
    expect(row["Docs Received"]).toBe("Y");
    expect(row["Docs Detail"]).toBe("Bylaws.pdf");
    expect(row["Docs First Received Date"]).toEqual(date("2026-09-04"));
  });

  it("counts completed staff-filed input documents without inventing client receipt dates", () => {
    const filed = { id: "file", entityId: "a", entityType: "ACCOUNT", name: "Budget.pdf", s3Key: "documents/ACCOUNT/a/file/Budget.pdf", category: "BUDGET", ocrStatus: "COMPLETE", lastWriteBy: "staff-user", createdAt: "2026-09-04T12:00:00Z" };
    const row = values({ documents: [filed] });
    expect(row["Docs Received"]).toBe("Y");
    expect(row["Docs Detail"]).toContain("Budget.pdf (filed in CRM; receipt date not recorded)");
    expect(row["Docs First Received Date"]).toBeNull();
    // Auto-naming can replace the last writer; availability does not rely on a staff-ID pattern.
    expect(values({ documents: [{ ...filed, lastWriteBy: "document-namer" }] })["Docs Received"]).toBe("Y");
    for (const change of [
      { ocrStatus: "PENDING" }, { s3Key: "pending" }, { s3Key: "generated/Budget.pdf" },
      { quoteId: "q" }, { policyId: "p" }, { category: "QUOTE_DOC" }, { category: "POLICY_DOC" },
      { category: "ACORD_FORM" }, { category: "OTHER" }, { sourceCommunicationId: "unverified" },
      { createdAt: "2026-10-01T12:00:00Z" },
    ]) expect(values({ documents: [{ ...filed, ...change }] })["Docs Received"], JSON.stringify(change)).toBe("Not recorded");
    const outgoing = comm("out", "OUTBOUND", "2026-09-03T12:00:00Z");
    expect(values({ documents: [{ ...filed, sourceCommunicationId: "out" }], communications: [outgoing] })["Docs Received"]).toBe("Not recorded");
  });

  it("indexes each source once and keeps account evidence isolated as the population grows", () => {
    let keyReads = 0;
    const accounts = Array.from({ length: 80 }, (_, i) => ({ id: `a${i}`, name: `Account ${i}`, stage: "LEAD" }));
    const quotes: ReportRecord[] = accounts.map(account => ({
      id: `q${account.id}`, get accountId() { keyReads++; return account.id; }, status: "PRESENTED", premium: Number(account.id.slice(1)) + 100,
    }));
    const report = buildMarketingLeadReport(snapshot({ accounts, quotes }), now);
    expect(report.rows).toHaveLength(80);
    for (const row of report.rows) expect(row[34]).toBe(Number(String(row[0]).slice(1)) + 100);
    // Bound operation-count assertion avoids a flaky machine-speed benchmark.
    expect(keyReads).toBeLessThanOrEqual(quotes.length * 3);
  });

  it("reports the newest email failure without counting it as human contact or inferring no contact route", () => {
    const row = values({ communications: [comm("sent", "OUTBOUND", "2026-09-02T12:00:00Z", { seenAt: "2026-09-03T12:00:00Z" }), comm("failed", "OUTBOUND", "2026-09-26T12:00:00Z", { status: "FAILED" })] });
    expect(row["Email Tracking Status"]).toBe("Delivery failed");
    expect(row["Last Agency Outbound Date"]).toEqual(date("2026-09-02"));
    expect(row.Status).not.toBe("CONTACT BLOCKED");
  });

  it("does not guess competitor loss, licensing disqualification or client-driven pause", () => {
    expect(values({ workflows: [{ accountId: "a", disposition: "LOST" }] }).Status).toBe("LOST - REASON NOT RECORDED");
    expect(values({ workflows: [{ accountId: "a", disposition: "DISQUALIFIED" }] }).Status).toBe("DISQUALIFIED");
    expect(values({ workflows: [{ accountId: "a", disposition: "ACTIVE", deferredUntil: "2026-10-01" }] }).Status).toBe("ACTIVE - DEFERRED");
  });

  it("uses Eastern calendar days across DST and rejects an invalid report time", () => {
    const row = values({ accounts: [{ id: "a", stage: "LEAD", createdAt: "2026-03-08T04:30:00Z" }] }, "2026-03-09T03:30:00Z");
    expect(row["Inquiry Date"]).toEqual(date("2026-03-07"));
    expect(row["Lead Age (Days)"]).toBe(1);
    expect(() => buildMarketingLeadReport(snapshot(), "invalid")).toThrow("timestamp");
    expect(() => buildMarketingLeadReport(snapshot(), "2026-02-30T12:00:00Z")).toThrow("timestamp");
    expect(MARKETING_REPORT_HEADERS.at(-1)).toBe("Notes");
  });

  it("labels long CRM notes as excerpts and keeps the report readable", () => {
    const row = values({ accounts: [{ id: "a", stage: "LEAD", notes: "Long source notes. ".repeat(100) }] });
    expect(String(row.Notes).length).toBeLessThan(340);
    expect(row.Notes).toContain("Excerpt; full details in CRM");
  });
});
