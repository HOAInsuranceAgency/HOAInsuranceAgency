import { describe, it, expect } from "vitest";
import { leadActionGuidance, canTakeResponse, workLink } from "../../../shared/leadActionGuidance";
import { selectReportItems, renderMorningReport, type MorningReport, type ReportItem } from "../../../shared/morningReport";
import { scheduleReminders, type LeadTask, type Communication } from "../../../shared/leadWorkflow";

const now = "2026-09-14T13:00:00.000Z";
const task = (patch: Partial<LeadTask>): LeadTask => scheduleReminders({ id: "t", accountId: "a", title: "Submit to Example Mutual", kind: "SUBMISSION", role: "CHAMPION", domain: "CARRIER", dueAt: now, status: "OPEN", escalationAt: "", version: 1, ...patch });
const item = (id: string, patch: Partial<ReportItem> = {}): ReportItem => ({ id, accountId: id, account: `Account ${id}`, title: id, why: "Follow-up needed", next: "Open the conversation", responsible: "Avery", section: "Your leads today", stage: "DUE", kind: "FIRST_CONTACT", group: "Sales", dueAt: "2025-01-01T14:00:00Z", ...patch });
const report = (items: ReportItem[]): MorningReport => ({ recipientId: "owner", name: "Owner", asOf: now, items, sections: [], complete: true, health: [], daily: true, accountCount: new Set(items.map(i => i.accountId)).size, teamCounts: [] });
describe("simple, accurate morning guidance", () => {
  it.each(["LEAD", "RENEWAL"] as const)("routes %s renewal-start work through the stage-aware renewal destination", context => {
    expect(workLink(task({ kind: "RENEWAL_START", context, policyId: "p", milestone: true }))).toEqual({ path: "/accounts/a?tab=renewal", label: "Review renewal" });
  });
  it.each(["2026-09-11", "2026-09-14"])("describes coverage needed %s without claiming a deadline is approaching", term => {
    const g = leadActionGuidance(task({ term, shortTimeline: true, businessDueAt: "2026-09-01T13:00:00Z" }), [], false, now);
    expect(g.why).not.toMatch(/approaching|remaining time/);
    expect(g.why).toContain(term < "2026-09-14" ? "has passed" : "needed today");
  });
  it("uses the agency date around midnight rather than tomorrow's UTC date", () => {
    expect(leadActionGuidance(task({ term: "2026-09-14" }), [], false, "2026-09-15T01:00:00Z").why).toContain("needed today");
  });
  it("strips quotes and the mobile signature from the original request", () => {
    const source = { id: "s", direction: "INBOUND", text: "Please call me.\nSent from my iPhone\n> On Sep 10 Avery wrote:\n> Old request" } as Communication;
    expect(leadActionGuidance(task({ kind: "RESPONSE", sourceIds: ["s"] }), [source], false, now).preview).toBe("Please call me.");
  });
  it("gives failed delivery a corrective action and never offers response takeover for milestones", () => {
    expect(leadActionGuidance(task({ kind: "CORRECTION" }), [], false, now).after).toContain("still bouncing");
    expect(canTakeResponse(task({ milestone: true }))).toBe(false);
    expect(canTakeResponse(task({ kind: "RESPONSE" }))).toBe(true);
    expect(workLink(task({ milestone: true })).path).toBe("/accounts/a?tab=quotes#carrier-work");
    expect(workLink(task({ kind: "DOCUMENTS" })).path).toBe("/accounts/a?tab=documents");
  });
  it("selects current replies and imminent carrier work ahead of a large legacy first-contact backlog", () => {
    const r = report([...Array.from({ length: 80 }, (_, n) => item(`legacy${n}`)), item("reply", { kind: "RESPONSE", dueAt: now }), item("renewal", { group: "Client and carrier", kind: "QUOTE_TARGET", term: "2026-09-20", dueAt: now }), item("setup", { group: "Setup and data", stage: "EXCEPTION" })]);
    const selected = selectReportItems(r);
    expect(selected).toHaveLength(20); expect(selected[0].id).toBe("reply"); expect(selected.map(i => i.id)).toContain("renewal"); expect(selected.map(i => i.id)).not.toContain("setup");
    const rendered = renderMorningReport(r, "https://crm.example.test");
    expect(rendered.html).toContain("Client and carrier"); expect(rendered.html).toContain("Setup and data"); expect(rendered.text).toContain("Open the conversation");
  });
  it("does not let one account with many tasks crowd out every other account", () => {
    const r = report([...Array.from({ length: 40 }, (_, n) => item(`same${n}`, { accountId: "same", kind: "RESPONSE" })), ...Array.from({ length: 10 }, (_, n) => item(`other${n}`))]);
    expect(new Set(selectReportItems(r).map(i => i.accountId)).size).toBe(11);
  });
  it("uses the same selected items for the HTML and plain text and retains safe action links", () => {
    const r = report([item("carrier", { group: "Client and carrier", url: "/accounts/a?tab=quotes", linkLabel: "Review quotes", account: "A & B <HOA>" })]);
    const rendered = renderMorningReport(r, "https://crm.example.test");
    expect(rendered.html).toContain("A &amp; B &lt;HOA&gt;"); expect(rendered.html).toContain('href="https://crm.example.test/accounts/a?tab=quotes"'); expect(rendered.text).toContain("https://crm.example.test/accounts/a?tab=quotes");
  });
});
