import { describe, expect, it } from "vitest";
import { annualReturn, quoteCoverage, quoteMatchesRisk, type QuoteEvidence } from "../../../shared/renewalPolicy";
import { businessDeadline, followUpDeadline, scheduleReminders, reminderWindow, taskWakeAt, type Communication, type LeadTask, type LeadWorkflow, type TeamEligibility, type TeamRouting } from "../../../shared/leadWorkflow";
import { taskRoute, validateRouting, validateCompleteRouting } from "../../../shared/workRouting";
import { morningReport, renderMorningReport } from "../../../shared/morningReport";
import { salespersonTask, salespersonRouting } from "../../../shared/salespersonOwnership";
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
  it("preserves the commitment and schedules reminders without escalation clocks", () => {
    const t = task();
    expect(t).toMatchObject({ reminderAt: "2026-09-10T13:00:00.000Z", dueAt: "2026-09-10T21:00:00.000Z" });
    expect(t).not.toHaveProperty("escalationAt"); expect(t).not.toHaveProperty("ownerEscalationAt");
    expect(taskWakeAt(t)).toBe(t.reminderAt);
    expect(taskWakeAt({ ...t, notifiedAt: "2026-09-10T13:00:00Z" })).toBe("2026-09-11T13:00:00.000Z");
    expect(taskWakeAt({ ...t, lastReminderAt: "2026-09-11T13:00:00Z" })).toBe("2026-09-14T13:00:00.000Z");
  });
  it("ignores old escalation clocks and preserves explicit next reminders and blocker reviews", () => {
    const t = { ...task(), escalationAt: "2020-01-01T13:00:00Z", escalatedAt: "2020-01-01T13:00:00Z", ownerEscalationAt: "2020-01-02T13:00:00Z", ownerNotifiedAt: "2020-01-02T13:00:00Z" };
    expect(taskWakeAt(t)).toBe(t.reminderAt);
    expect(taskWakeAt({ ...t, nextReminderAt: "2026-09-15T13:00:00Z" })).toBe("2026-09-15T13:00:00Z");
    expect(taskWakeAt({ ...t, nextReminderAt: "2026-09-15T13:00:00Z", blocker: { ownerId: "cover", reason: "Carrier review", reviewAt: "2026-09-14T13:00:00Z", recordedAt: "2026-09-11T13:00:00Z", recordedBy: "sales1" } })).toBe("2026-09-14T13:00:00Z");
    expect(taskWakeAt({ ...t, status: "COMPLETE" })).toBeUndefined();
    expect(scheduleReminders(t)).not.toHaveProperty("escalatedAt");
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
describe("assigned-person routing", () => {
  it("routes only to the assigned salesperson despite legacy reporting relationships", () => {
    expect(taskRoute(task(), workflow, routing, people)).toEqual({ accountableId: "sales1", assigneeId: "sales1", recipientId: "sales1", role: "SALESPERSON", gaps: [] });
    expect(taskRoute(task(), { ...workflow, salespersonId: "sales2" }, routing, people).recipientId).toBe("sales2");
  });
  it.each(["RENEWAL", "SERVICE"] as const)("keeps legacy bound-client %s work with the salesperson", context => {
    expect(taskRoute(task({ context, domain: "CLIENT", role: "CHAMPION" }), { ...workflow, disposition: "BOUND" }, routing, people).recipientId).toBe("sales1");
  });
  it.each(["SALES_ASSIST", "MANAGER_COVER", undefined] as const)("ignores a legacy helper assignment with reason %s", helperReason => {
    expect(taskRoute(task({ helperId: "manager1", helperReason }), workflow, routing, people).recipientId).toBe("sales1");
    expect(taskRoute(task({ domain: "CARRIER", kind: "CARRIER", role: "CHAMPION" }), workflow, routing, people).recipientId).toBe("sales1");
  });
  it("ignores away and dated coverage settings without changing the original task", () => {
    const t = task(), before = structuredClone(t);
    const settings: TeamRouting = { ...routing, members: [{ userId: "sales1", salesManagerId: "manager1", away: true, coverId: "cover", coverFrom: "2026-09-10", coverThrough: "2026-09-11" }] };
    for (const now of ["2026-09-11T13:00:00Z", "2026-09-14T13:00:00Z"]) expect(taskRoute(t, workflow, settings, people, now).recipientId).toBe("sales1");
    expect(t).toEqual(before);
  });
  it.each(["disabled", "ineligible", "missing"])("does not reroute a %s salesperson's tasks to management", state => {
    const team = state === "missing" ? people.filter(m => m.userId !== "sales1") : people.map(m => m.userId === "sales1" ? { ...m, enabled: state !== "disabled", salesperson: state !== "ineligible" } : m);
    expect(taskRoute(task(), workflow, routing, team)).toMatchObject({ accountableId: "sales1", recipientId: undefined, gaps: ["Assign an enabled salesperson to this account"] });
  });
  it("retains specialist and blocker context but sends reminders only to the account salesperson", () => {
    const t = task({ specialistId: "cover" });
    expect(taskRoute(t, workflow, routing, people)).toMatchObject({ assigneeId: "cover", recipientId: "sales1" });
    expect(taskRoute({ ...t, blocker: { ownerId: "sales2", reason: "Carrier review", reviewAt: t.dueAt, recordedAt: t.dueAt, recordedBy: "sales1" } }, workflow, routing, people)).toMatchObject({ assigneeId: "sales2", recipientId: "sales1" });
    const unavailable = people.map(m => m.userId === "cover" ? { ...m, enabled: false } : m);
    expect(taskRoute(t, workflow, routing, unavailable)).toMatchObject({ assigneeId: "cover", recipientId: "sales1", gaps: [] });
    expect(taskRoute(t, { ...workflow, salespersonId: undefined }, routing, people)).toMatchObject({ assigneeId: "cover", recipientId: undefined, gaps: ["Assign an enabled salesperson to this account"] });
  });
  it("sanitizes retired relationships while validating operational delivery contacts", () => {
    const legacy = { ...routing, intakeOwnerId: "sales1", integrationOwnerId: "cover", reportChannelId: "cha_internal", members: [{ userId: "sales1", salesManager: true, salesManagerId: "sales1", coverId: "missing", away: true }] };
    expect(salespersonRouting(legacy)).toEqual({ version: 1, ownerId: "owner", intakeOwnerId: "sales1", integrationOwnerId: "cover", reportChannelId: "cha_internal", members: [] });
    expect(() => validateCompleteRouting(legacy, people)).not.toThrow();
    expect(() => validateRouting({ ...legacy, ownerId: "missing" }, people)).toThrow("enabled CRM teammate");
    expect(() => validateRouting({ ...legacy, reportChannelId: "invalid" }, people)).toThrow("reporting channel");
    expect(() => validateCompleteRouting({ ...legacy, ownerId: undefined }, people)).toThrow("report issues contact");
    expect(legacy.members).toHaveLength(1);
  });
});
describe("morning editions", () => {
  const report = (id: string, now: string, tasks = [task()]) => morningReport({ recipientId: id, team: people, routing, workflows: [workflow], tasks, now, health: [] });
  it("keeps overdue work in the assigned person's report regardless of old escalation dates", () => {
    const old = { ...task(), escalationAt: "2026-09-11T13:00:00Z", ownerEscalationAt: "2026-09-14T13:00:00Z", escalatedAt: "2026-09-11T13:00:00Z", ownerNotifiedAt: "2026-09-14T13:00:00Z", helperId: "manager1", helperReason: "MANAGER_COVER" as const };
    for (const id of ["manager1", "manager2", "owner", "champ"]) expect(report(id, "2026-09-15T13:00:00Z", [old]).items).toEqual([]);
    const own = report("sales1", "2026-09-15T13:00:00Z", [old]);
    expect(own.items).toHaveLength(1); expect(own.items[0].stage).toBe("DUE"); expect(own).not.toHaveProperty("teamCounts");
    expect(renderMorningReport(own, "https://crm.example.com").text).not.toMatch(/manager|covering|owner help|take over/i);
    expect(report("sales1", "2026-09-15T13:00:00Z", [task({ status: "COMPLETE" })]).items).toEqual([]);
  });
  it("shows operational contacts only their own assigned business work", () => {
    const r = morningReport({ recipientId: "owner", team: people, routing, workflows: [{ ...workflow, salespersonId: "owner" }], tasks: [task()], now: "2026-09-15T13:00:00Z", health: [] });
    expect(r.items).toHaveLength(1); expect(r.items[0].stage).toBe("DUE");
  });
  it("does not create daily manager editions without salesperson eligibility", () => {
    const r = morningReport({ recipientId: "manager1", team: people.map(m => m.userId === "manager1" ? { ...m, salesperson: false } : m), routing, workflows: [workflow], tasks: [task()], now: "2026-09-15T13:00:00Z", health: [] });
    expect(r).toMatchObject({ daily: false, items: [], sections: [] });
  });
  it("keeps specialist and blocker work in the account salesperson's report without disclosing it to delegates", () => {
    const specialist = task({ id: "specialist", specialistId: "cover", context: "SERVICE" });
    const blocker = task({ id: "blocker", blocker: { ownerId: "sales2", reason: "Carrier review", reviewAt: "2026-09-15T13:00:00Z", recordedAt: "2026-09-11T13:00:00Z", recordedBy: "sales1" } });
    const own = report("sales1", "2026-09-15T13:00:00Z", [specialist, blocker]);
    expect(own.items).toHaveLength(2);
    expect(own.items.find(i => i.id === "specialist")).toMatchObject({ role: "Salesperson", responsible: "sales1" });
    expect(own.items.find(i => i.id === "blocker")).toMatchObject({ role: "Salesperson", responsible: "sales1", blockerOwner: "sales2", blockerReviewAt: blocker.blocker!.reviewAt });
    for (const id of ["cover", "sales2"]) {
      const other = report(id, "2026-09-15T13:00:00Z", [specialist, blocker]);
      expect(other.items).toEqual([]);
      expect(renderMorningReport(other, "https://crm.example.com").text).not.toContain(workflow.name);
    }
    expect(specialist.specialistId).toBe("cover"); expect(blocker.blocker?.reason).toBe("Carrier review");
  });
  it("discloses incomplete data, escapes names, and makes email truncation explicit", () => {
    const r = report("sales1", "2026-09-10T13:00:00Z", Array.from({ length: 23 }, (_, i) => task({ id: `t${i}` })));
    r.health = ["Activity check incomplete"]; r.complete = false; r.items[0].account = "<script>alert(1)</script>";
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
    expect(quoteCoverage([{ ...quote, carrierId: null }], risk, "2026-11-01").complete).toBe(false);
    expect(quoteCoverage([{ ...quote, offerExpiresAt: "2026-10-31" }], risk, "2026-11-01").complete).toBe(false);
    expect(quoteCoverage([{ ...quote, offerExpiresAt: "2026-10-31" }], risk, "2026-11-01T02:00:00Z").complete).toBe(true); // Still October 31 in the agency's timezone.
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

describe("legacy ownership compatibility", () => {
  it("removes helper and escalation metadata without losing evidence or the actual deadline", () => {
    const old = { ...task({ role: "CHAMPION", accountableRole: "CHAMPION", kind: "FOLLOW_UP", domain: undefined, context: "RENEWAL", policyId: "p1" }), helperId: "manager1", helperRequestedBy: "sales1", helperReason: "MANAGER_COVER" as const,
      escalationAt: "2026-09-11T13:00:00Z", ownerEscalationAt: "2026-09-14T13:00:00Z", escalatedAt: "2026-09-11T13:00:00Z", ownerNotifiedAt: "2026-09-14T13:00:00Z", escalatedRecipientId: "manager1", managerRecipientId: "manager1", ownerRecipientId: "owner", sourceIds: ["source"], nextReminderAt: "2026-09-15T13:00:00Z" };
    const normalized = salespersonTask(old);
    expect(normalized).toMatchObject({ id: old.id, role: "SALESPERSON", accountableRole: "SALESPERSON", domain: "CARRIER", context: "RENEWAL", policyId: "p1", dueAt: old.dueAt, sourceIds: ["source"], nextReminderAt: old.nextReminderAt });
    for (const field of ["helperId", "helperReason", "helperRequestedBy", "escalationAt", "ownerEscalationAt", "escalatedAt", "escalatedRecipientId", "ownerNotifiedAt", "managerRecipientId", "ownerRecipientId"]) expect(normalized).not.toHaveProperty(field);
    expect(old.helperId).toBe("manager1");
  });
  it("preserves explicit specialist work", () => {
    const specialist = salespersonTask(task({ role: "CHAMPION", context: "SERVICE", specialistId: "cover" }));
    expect(specialist.specialistId).toBe("cover");
    expect(taskRoute(specialist, workflow, routing, people)).toMatchObject({ accountableId: "sales1", recipientId: "sales1" });
  });
  it("includes carrier and bound-client work only in the assigned salesperson's report", () => {
    const tasks = [task({ id: "carrier", kind: "CARRIER", role: "CHAMPION", domain: "CARRIER" }), task({ id: "renewal", context: "RENEWAL", role: "CHAMPION" }), task({ id: "service", context: "SERVICE", role: "CHAMPION" })];
    const report = (recipientId: string) => morningReport({ recipientId, team: people, routing, workflows: [workflow], tasks, now: "2026-09-11T13:00:00Z", health: [] });
    expect(report("sales1").items).toHaveLength(3);
    expect(report("sales1").items.every(i => i.section === "Your accounts today" && i.role === "Salesperson")).toBe(true);
    for (const id of ["manager1", "owner", "champ", "marketing"]) expect(report(id).items).toHaveLength(0);
  });
});
