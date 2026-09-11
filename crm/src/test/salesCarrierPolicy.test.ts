import { describe, expect, it } from "vitest";
import { annualReturn, quoteCoverage, quoteMatchesRisk, type QuoteEvidence } from "../../../shared/renewalPolicy";
import { businessDeadline, followUpDeadline, scheduleReminders, reminderWindow, taskWakeAt, type Communication, type LeadTask, type LeadWorkflow, type TeamEligibility, type TeamRouting } from "../../../shared/leadWorkflow";
import { taskRoute, validateRouting } from "../../../shared/workRouting";
import { morningReport, renderMorningReport } from "../../../shared/morningReport";
import { contactProgress } from "../../../shared/contactProgress";

const member = (id: string): TeamEligibility => ({ userId: id, name: id, email: `${id}@example.com`, salesperson: true, champion: true, enabled: true });
const people = ["sales1", "sales2", "champ", "manager1", "manager2", "marketing", "owner", "cover"].map(member);
const routing: TeamRouting = { version: 1, ownerId: "owner", marketingManagerId: "marketing", members: [
  { userId: "sales1", salesManagerId: "manager1" }, { userId: "sales2", salesManagerId: "manager2" }, { userId: "manager1", salesManager: true }, { userId: "manager2", salesManager: true }, { userId: "marketing", marketingManager: true },
] };
const workflow: LeadWorkflow = { accountId: "a", name: "Cedar Association", salespersonId: "sales1", championId: "champ", disposition: "ACTIVE", version: 1, updatedAt: "2026-09-10T13:00:00Z" };
const task = (patch: Partial<LeadTask> = {}): LeadTask => scheduleReminders({ id: "t", accountId: "a", title: "Respond", kind: "RESPONSE", role: "SALESPERSON", context: "LEAD", domain: "CLIENT", dueAt: "2026-09-10T21:00:00.000Z", escalationAt: "", status: "OPEN", version: 1, ...patch });
describe("calendar and annual lead rollover", () => {
  it("moves the incumbent exactly one calendar year and returns 90 days before it", () => {
    expect(annualReturn("2026-12-01", [], "2026-09-10T13:00:00Z")).toMatchObject({ expiration: "2027-12-01", threshold: "2027-09-02", returnAt: "2027-09-02T13:00:00.000Z" });
  });
  it("clamps February 29, and does not replace an old date with today plus a year", () => {
    expect(annualReturn("2028-02-29", [], "2026-09-10T13:00:00Z").expiration).toBe("2029-02-28");
    expect(annualReturn("2020-12-01", [], "2026-09-10T13:00:01Z")).toMatchObject({ expiration: "2021-12-01", stale: true, returnAt: "2026-09-11T13:00:00.000Z" });
    expect(() => annualReturn("2026-02-30", [], "2026-09-10T13:00:00Z")).toThrow();
  });
  it("uses the preceding business morning when the 90-day threshold is a holiday", () => {
    expect(annualReturn("2026-12-01", ["2027-09-02"], "2026-09-10T13:00:00Z").returnAt).toBe("2027-09-01T13:00:00.000Z");
  });
  it("preserves a Thursday 5pm commitment, with Friday manager and Monday owner mornings", () => {
    const t = task();
    expect(t).toMatchObject({ reminderAt: "2026-09-10T13:00:00.000Z", escalationAt: "2026-09-11T13:00:00.000Z", ownerEscalationAt: "2026-09-14T13:00:00.000Z", dueAt: "2026-09-10T21:00:00.000Z" });
    expect(taskWakeAt({ ...t, escalatedAt: t.escalationAt })).toBe(t.ownerEscalationAt);
    expect(taskWakeAt({ ...t, ownerNotifiedAt: t.ownerEscalationAt, nextReminderAt: "2026-09-15T13:00:00Z" })).toBe("2026-09-15T13:00:00Z");
  });
  it("honors staffed hours, daylight savings and holidays", () => {
    expect(businessDeadline("2026-11-06T21:00:00Z", 1, ["2026-11-09"])).toBe("2026-11-10T21:00:00.000Z");
    expect(followUpDeadline("2026-10-30T14:00:00Z", 1)).toBe("2026-11-02T14:00:00.000Z");
    expect(reminderWindow("2026-09-10T21:00:00Z")).toBe(false);
    expect(reminderWindow("2026-09-12T13:00:00Z")).toBe(false);
    expect(reminderWindow("2026-09-10T13:09:59Z")).toBe(true);
    expect(reminderWindow("2026-09-10T13:10:00Z")).toBe(false);
  });
});
describe("responsibility and escalation routing", () => {
  it("separates two sales managers despite a shared champion", () => {
    expect(taskRoute(task(), workflow, routing, people)).toMatchObject({ recipientId: "sales1", managerId: "manager1", ownerId: "owner" });
    expect(taskRoute(task(), { ...workflow, salespersonId: "sales2" }, routing, people).managerId).toBe("manager2");
  });
  it.each(["RENEWAL", "SERVICE"] as const)("routes bound-client %s through champion and marketing manager", context => {
    expect(taskRoute(task({ context, domain: "CLIENT", role: "CHAMPION" }), { ...workflow, disposition: "BOUND" }, routing, people)).toMatchObject({ recipientId: "champ", managerId: "marketing" });
  });
  it("does not confuse champion prospect help with carrier work", () => {
    expect(taskRoute(task({ helperId: "champ" }), workflow, routing, people)).toMatchObject({ recipientId: "champ", managerId: "manager1", accountableId: "sales1" });
    expect(taskRoute(task({ domain: "CARRIER", kind: "CARRIER", role: "CHAMPION" }), workflow, routing, people)).toMatchObject({ recipientId: "champ", managerId: "marketing" });
  });
  it("changes cover without changing the task deadline or management clock", () => {
    const t = task(), before = structuredClone(t);
    expect(taskRoute(t, workflow, { ...routing, members: [...routing.members.filter(m => m.userId !== "sales1"), { userId: "sales1", salesManagerId: "manager1", away: true, coverId: "cover" }] }, people)).toMatchObject({ recipientId: "cover", managerId: "manager1" });
    expect(t).toEqual(before);
  });
  it("falls back to an owned exception when cover is missing", () => {
    const r = taskRoute(task(), workflow, routing, people.map(m => m.userId === "sales1" ? { ...m, enabled: false } : m));
    expect(r.recipientId).toBe("manager1"); expect(r.gaps.length).toBeGreaterThan(0);
  });
  it("checks scheduled cover availability and restores the normal salesperson when leave ends", () => {
    const settings: TeamRouting = { ...routing, members: [...routing.members.filter(m => m.userId !== "sales1"),
      {userId:"sales1",salesManagerId:"manager1",coverId:"cover",coverFrom:"2026-09-10",coverThrough:"2026-09-11"},
      {userId:"cover",away:true,coverId:"sales2"}] };
    expect(taskRoute(task(),workflow,settings,people,"2026-09-11T13:00:00Z")).toMatchObject({recipientId:"sales2",managerId:"manager1",accountableId:"sales1"});
    expect(taskRoute(task(),workflow,settings,people,"2026-09-14T13:00:00Z").recipientId).toBe("sales1");
  });
  it("rejects self-management, cycles and unavailable cover", () => {
    expect(() => validateRouting(routing, people)).not.toThrow();
    expect(() => validateRouting({ ...routing, members: [{ userId: "sales1", salesManager: true, salesManagerId: "sales1" }] }, people)).toThrow();
    expect(() => validateRouting({ ...routing, marketingManagerId: undefined, members: [{ userId: "sales1", salesManager: true, salesManagerId: "sales2" }, { userId: "sales2", salesManager: true, salesManagerId: "sales1" }] }, people)).toThrow("loop");
  });
});
describe("morning editions", () => {
  const report = (id: string, now: string, tasks = [task()]) => morningReport({ recipientId: id, team: people, routing, workflows: [workflow], tasks, now, health: [] });
  it("keeps due visibility separate from actual manager escalation", () => {
    const before = report("manager1", "2026-09-10T13:00:00Z");
    expect(before.items).toHaveLength(0); expect(before.teamCounts).toEqual([{ name: "sales1", due: 1, overdue: 0 }]);
    expect(report("manager1", "2026-09-11T13:00:00Z").items[0].stage).toBe("MANAGER");
    expect(report("manager2", "2026-09-11T13:00:00Z").items).toHaveLength(0);
    expect(report("champ", "2026-09-11T13:00:00Z").items).toHaveLength(0);
  });
  it("continues manager and owner visibility on later mornings until actual completion", () => {
    expect(report("owner", "2026-09-11T13:00:00Z").items).toHaveLength(0);
    expect(report("owner", "2026-09-14T13:00:00Z").items[0].stage).toBe("OWNER");
    expect(report("owner", "2026-09-15T13:00:00Z").items).toHaveLength(1);
    expect(report("owner", "2026-09-15T13:00:00Z", [task({ status: "COMPLETE" })]).items).toHaveLength(0);
  });
  it("counts a combined role once and does not escalate an owner to themself", () => {
    const r = morningReport({ recipientId: "owner", team: people, routing, workflows: [{ ...workflow, salespersonId: "owner", championId: "owner" }], tasks: [task()], now: "2026-09-15T13:00:00Z", health: [] });
    expect(r.items).toHaveLength(1); expect(r.items[0].stage).toBe("DUE");
  });
  it("discloses incomplete coverage, escapes names, and makes email truncation explicit", () => {
    const r = report("sales1", "2026-09-10T13:00:00Z", Array.from({ length: 23 }, (_, i) => task({ id: `t${i}` })));
    r.health = ["Coverage check incomplete"]; r.complete = false; r.items[0].account = "<script>alert(1)</script>";
    const rendered = renderMorningReport(r, "https://crm.example.com");
    expect(rendered.html).toContain("And 3 more"); expect(rendered.html).toContain("&lt;script&gt;"); expect(rendered.html).not.toContain("<script>"); expect(rendered.text).toContain("could not be verified");
  });
});
describe("usable quote evidence", () => {
  const risk = { accountId: "a", policyId: "p", term: "2026-12-01", lines: ["Property", "Liability"] };
  const quote: QuoteEvidence = { accountId: "a", carrierId: "c", status: "QUOTED", effectiveDate: "2026-12-01", expirationDate: "2027-12-01", premium: 12000, lines: ["Property", "Liability"], renewalPolicyId: "p" };
  it.each(["DRAFT", "SUBMITTED", "DECLINED", "LOST"])("does not treat %s as a usable quote", status => expect(quoteCoverage([{ ...quote, status }], risk, "2026-11-01").complete).toBe(false));
  it("matches actual term, risk and all required lines, not quote creation date", () => {
    expect(quoteCoverage([quote], risk, "2026-11-01").complete).toBe(true);
    expect(quoteCoverage([{ ...quote, effectiveDate: "2025-12-01" }], risk, "2026-11-01").complete).toBe(false);
    expect(quoteCoverage([{ ...quote, lines: ["Property"] }], risk, "2026-11-01")).toMatchObject({ complete: false, missingLines: ["Liability"] });
    expect(quoteMatchesRisk({ ...quote, renewalPolicyId: "different" }, risk)).toBe(false);
    expect(quoteCoverage([{ ...quote, premium: null }], risk, "2026-11-01").complete).toBe(false);
    expect(quoteCoverage([{ ...quote, offerExpiresAt: "2026-10-31" }], risk, "2026-11-01").complete).toBe(false);
  });
  it("keeps contact evidence separate from business results and internal reports", () => {
    const call = { id: "c", providerId: "c", provider: "dialpad", channel: "CALL", direction: "OUTBOUND", at: "2026-09-10T13:00:00Z", status: "MISSED", version: 1 } as const;
    expect(contactProgress(call)).toBeUndefined();
    expect(contactProgress({ ...call, endedAt: call.at })).toBe("ATTEMPT");
    expect(contactProgress({ ...call, endedAt: call.at, internalReport: true })).toBeUndefined();
  });
});

describe("service work is recorded by the response", () => {
  it("does not treat acknowledgements or a forwarded request as delivered service", async () => {
    const { interimResponse, serviceRequestType } = await import("../../../shared/serviceEvidence");
    const base = { id: "source", providerId: "m", provider: "front", channel: "EMAIL", direction: "OUTBOUND", status: "SENT", version: 1, at: "2026-09-10T13:00:00Z" } as Communication;
    expect(interimResponse({ ...base, text: "Thanks, I will check with the adjuster and get back to you." })).toBe(true);
    expect(interimResponse({ ...base, text: "Forwarded your request to our billing specialist." })).toBe(true);
    expect(interimResponse({ ...base, text: "Thanks!\nOn Tuesday Jane wrote:\nThe problem is resolved." })).toBe(true);
    expect(serviceRequestType({ ...base, text: "Please send a certificate of insurance for my lender." })).toBe("CERTIFICATE");
    expect(interimResponse({ ...base, text: "Your billing question is resolved: the duplicate charge was reversed and the balance is zero." })).toBe(false);
  });
});
