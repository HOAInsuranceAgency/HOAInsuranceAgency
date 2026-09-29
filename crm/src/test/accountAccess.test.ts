import { beforeEach, describe, expect, it } from "vitest";
import { AccountAccess, type Reader } from "../../amplify/functions/crm-access/access";
import { authorizeCustom, filterCustom } from "../../amplify/functions/crm-access/custom";
import { ACCOUNT_MODELS, AccessDenied, type RecordData } from "../../amplify/functions/crm-access/policy";
let records: Record<string, RecordData>;
const reader: Reader = async (model, key) => records[`${model}:${key}`];
const user = (sub = "alice") => new AccountAccess({ sub }, reader);
const admin = () => new AccountAccess({ sub: "admin", groups: ["ADMIN"] }, reader);
beforeEach(() => {
  records = {
    "Communication:team-routing": { data: { members: [{ userId: "manager", salesManager: true }, { userId: "alice", salesManagerId: "manager" }, { userId: "bob", salesManagerId: "other-manager" }] } },
    "Communication:workflow:a": { data: { salespersonId: "alice" } },
    "Communication:workflow:b": { data: { salespersonId: "bob" } },
    "Account:a": { id: "a", coverPhotoKey: "property-photos/a/coverPhotoKey-cover.jpg" }, "Account:b": { id: "b" },
    "Certificate:cert": { id: "cert", accountId: "a", s3Key: "certificates/a/cert.pdf" },
    "Quote:qa": { id: "qa", accountId: "a" }, "Quote:qb": { id: "qb", accountId: "b" },
    "Policy:pa": { id: "pa", accountId: "a" }, "Policy:pb": { id: "pb", accountId: "b" },
    "Invoice:ia": { id: "ia", accountId: "a" }, "Invoice:ib": { id: "ib", accountId: "b" },
    "PfLoan:la": { id: "la", accountId: "a" }, "PfLoan:lb": { id: "lb", accountId: "b" },
    "Document:da": { id: "da", entityType: "ACCOUNT", entityId: "a", s3Key: "documents/ACCOUNT/a/da/file.pdf" },
    "Document:db": { id: "db", entityType: "ACCOUNT", entityId: "b", s3Key: "documents/ACCOUNT/b/db/file.pdf" },
    "UserProfile:alice-profile": { id: "alice-profile", userId: "alice", role: "ADMIN" },
    "UserProfile:bob-profile": { id: "bob-profile", userId: "bob" },
    "Carrier:carrier": { id: "carrier" },
    "Communication:task:a": { accountId: "a", data: { accountId: "a" } },
    "Communication:task:b": { accountId: "b", data: { accountId: "b" } },
    "Communication:front-link:cnv_a": { accountId: "a", data: { accountId: "a" } },
    "Communication:front-link:cnv_b": { accountId: "b", data: { accountId: "b" } },
    "HoneycombEstimate:ea": { id: "ea", accountId: "a" }, "HoneycombEstimate:eb": { id: "eb", accountId: "b" },
  };
});
describe("current account assignment", () => {
  it("limits salespeople to their accounts, including direct guessed IDs", async () => {
    expect(await user().canAccount("a")).toBe(true);
    expect(await user().canAccount("b")).toBe(false);
    await expect(user().requireRecord("Account", "b")).rejects.toBeInstanceOf(AccessDenied);
    expect(await user().canAccount("unassigned")).toBe(false);
    expect(await admin().canAccount("unassigned")).toBe(true);
  });
  it("ignores every retired manager, agency-owner and coverage grant", async () => {
    records["Communication:team-routing"].data = {
      ownerId: "owner", intakeOwnerId: "intake", integrationOwnerId: "integration",
      members: [{ userId: "manager", salesManager: true }, { userId: "alice", salesManagerId: "manager", coverId: "cover", away: true }],
    };
    for (const actor of ["manager", "owner", "intake", "integration", "cover"]) {
      expect(await user(actor).salespeople()).toEqual(new Set([actor]));
      expect(await user(actor).canAccount("a")).toBe(false);
      await expect(user(actor).requireRecord("Account", "a")).rejects.toThrow(AccessDenied);
      await expect(user(actor).requireSalesperson("alice")).rejects.toThrow(AccessDenied);
    }
    records["Communication:workflow:owned"] = { data: { salespersonId: "manager" } };
    expect(await user("manager").canAccount("owned")).toBe(true);
    expect(await admin().canAccount("a")).toBe(true);
    await expect(admin().requireSalesperson("alice")).resolves.toBeUndefined();
  });
  it("does not accept the self-editable profile role as authority", async () => {
    expect(user().admin).toBe(false);
    expect(await user().canAccount("b")).toBe(false);
    expect(new AccountAccess({ sub: "admin", claims: { "cognito:groups": ["ADMIN"] } }, reader).admin).toBe(true);
    expect(() => new AccountAccess(undefined, reader)).toThrow(AccessDenied);
  });
  it("rechecks reassignment on the next request without consulting obsolete manager changes", async () => {
    expect(await user().canAccount("a")).toBe(true);
    records["Communication:workflow:a"] = { data: { salespersonId: "bob" } };
    expect(await user().canAccount("a")).toBe(false);
    expect(await user("manager").canAccount("a")).toBe(false);
    expect(await user("bob").canAccount("a")).toBe(true);
    records["Communication:team-routing"].data = { members: [{ userId: "manager", salesManager: true }, { userId: "bob", salesManagerId: "manager" }] };
    expect(await user("manager").canAccount("a")).toBe(false);
  });
  it("hides retired accounts and denies records without an assignment", async () => {
    records["Communication:deleted-account:a"] = { id: "deleted-account:a" };
    expect(await user().canAccount("a")).toBe(false);
    delete records["Communication:workflow:b"];
    expect(await user("bob").canAccount("b")).toBe(false);
  });
  it("does not turn storage failures into access", async () => {
    const broken = new AccountAccess({ sub: "alice" }, async () => { throw new Error("offline"); });
    await expect(broken.canRecord("Account", { id: "a" })).rejects.toThrow("offline");
  });
});
describe("all related models", () => {
  const record = (model: string, suffix: string) => {
    if (model === "Account") return { id: suffix };
    if (model === "Activity") return { entityId: suffix };
    if (model === "Document") return { entityType: "ACCOUNT", entityId: suffix };
    if (model === "InvoiceLine") return { invoiceId: `i${suffix}`, accountId: "a" };
    if (["PfNotice", "PfLoanPayment"].includes(model)) return { loanId: `l${suffix}`, accountId: "a" };
    if (model === "PfOverride") return { policyId: `p${suffix}` };
    return { accountId: suffix };
  };
  it.each(ACCOUNT_MODELS)("checks %s through its authoritative account", async model => {
    expect(await user().canRecord(model, record(model, "a"))).toBe(true);
    expect(await user().canRecord(model, record(model, "b"))).toBe(false);
    expect(await user("manager").canRecord(model, record(model, "a"))).toBe(false);
    expect(await admin().canRecord(model, record(model, "a"))).toBe(true);
  });
  it("derives quote/policy documents from the parent and retains shared carrier files", async () => {
    expect(await user().canRecord("Document", { entityType: "POLICY", entityId: "pb" })).toBe(false);
    expect(await user().canRecord("Document", { entityType: "QUOTE", entityId: "qa" })).toBe(true);
    expect(await user().canRecord("Document", { entityType: "CARRIER", entityId: "carrier" })).toBe(true);
    expect(await user().canRecord("Document", { entityType: "UNKNOWN", entityId: "a" })).toBe(false);
  });
  it("fails closed for unknown models and malformed or orphaned records", async () => {
    expect(await user().canRecord("Unknown", { accountId: "a" })).toBe(false);
    expect(await user().canRecord("Quote", {})).toBe(false);
    expect(await user().canRecord("InvoiceLine", { invoiceId: "gone", accountId: "a" })).toBe(false);
  });
});
describe("model writes", () => {
  it.each(["create", "update", "delete"])("rejects %s on a foreign record", async operation => {
    await expect(user().write("Quote", operation, { id: "qb", accountId: "b" })).rejects.toThrow(AccessDenied);
  });
  it("prevents claiming an existing record by changing its parent", async () => {
    await expect(user().write("Quote", "update", { id: "qb", accountId: "a" })).rejects.toThrow(AccessDenied);
    await expect(user().write("Quote", "update", { id: "qa", accountId: "b" })).rejects.toThrow(AccessDenied);
    await expect(user().write("Quote", "create", { id: "qb", accountId: "a" })).rejects.toThrow(AccessDenied);
    await expect(user().write("Quote", "update", { id: "qa", premium: 1000 })).resolves.toBeUndefined();
  });
  it("requires secondary references to be on the same account even when both accounts are assigned to the actor", async () => {
    records["Communication:workflow:b"] = { data: { salespersonId: "alice" } };
    await expect(user().write("Document", "update", { id: "da", policyId: "pb" })).rejects.toThrow(AccessDenied);
    await expect(user().write("Document", "update", { id: "da", policyId: "pa" })).resolves.toBeUndefined();
  });
  it("checks natural accountId keys and the existing parent before delete", async () => {
    records["GlApplication:a"] = { accountId: "a" };
    records["GlApplication:b"] = { accountId: "b" };
    await expect(user().write("GlApplication", "update", { accountId: "a" })).resolves.toBeUndefined();
    await expect(user().write("GlApplication", "delete", { accountId: "b" })).rejects.toThrow(AccessDenied);
  });
  it("rejects cross-account certificate policies and communication links", async () => {
    await expect(user().write("Certificate", "create", { accountId: "a", policyIds: ["pb"] })).rejects.toThrow(AccessDenied);
    await expect(user().write("Document", "update", { id: "da", sourceCommunicationId: "task:b" })).rejects.toThrow(AccessDenied);
    await expect(user().write("Document", "update", { id: "da", sourceCommunicationId: "task:a" })).resolves.toBeUndefined();
  });
  it("keeps profile writes owned by the signed-in user", async () => {
    await expect(user().write("UserProfile", "update", { id: "bob-profile", firstName: "Changed" })).rejects.toThrow(AccessDenied);
    await expect(user().write("UserProfile", "update", { id: "alice-profile", userId: "bob" })).rejects.toThrow(AccessDenied);
    await expect(user().write("UserProfile", "update", { id: "alice-profile", firstName: "Alice" })).resolves.toBeUndefined();
  });
});
describe("files", () => {
  it("denies former managers copied document, generated, policy, certificate and photo URLs", async () => {
    for (const path of ["documents/ACCOUNT/a/da/file.pdf", "generated/a/form.pdf", "generated/pf/la/premium-finance-agreement.pdf", "certificates/a/cert.pdf", "property-photos/a/coverPhotoKey-cover.jpg"]) {
      await expect(user("manager").path(path, "read")).rejects.toThrow(AccessDenied);
      await expect(admin().path(path, "read")).resolves.toBeUndefined();
    }
  });
  it.each(["read", "write", "delete"] as const)("checks %s access to document, generated, certificate, and photo keys", async op => {
    for (const path of ["documents/ACCOUNT/b/db/file.pdf", "generated/b/form.pdf", "certificates/b/cert.pdf", "property-photos/b/cover.jpg"]) await expect(user().path(path, op)).rejects.toThrow(AccessDenied);
    for (const path of ["documents/ACCOUNT/a/da/file.pdf", "generated/a/form.pdf", "property-photos/a/coverPhotoKey-cover.jpg"]) await expect(user().path(path, op)).resolves.toBeUndefined();
  });
  it("binds certificate files to their record and preserves administrator-only deletion", async () => {
    for (const op of ["read", "write", "link"] as const) await expect(user().path("certificates/a/cert.pdf", op)).resolves.toBeUndefined();
    await expect(user().path("certificates/a/cert.pdf", "delete")).rejects.toThrow(AccessDenied);
    await expect(admin().path("certificates/a/cert.pdf", "delete")).resolves.toBeUndefined();
    await expect(user().path("certificates/a/unknown.pdf", "write")).rejects.toThrow(AccessDenied);
    records["Certificate:cert"].accountId = "b";
    await expect(user().path("certificates/a/cert.pdf", "write")).rejects.toThrow(AccessDenied);
    await expect(user().path("property-photos/a/arbitrary.pdf", "write")).rejects.toThrow(AccessDenied);
  });
  it("makes only the stored loan's exact generated agreement readable, never client-writable", async () => {
    const path = "generated/pf/la/premium-finance-agreement.pdf";
    await expect(user().path(path, "read")).resolves.toBeUndefined();
    await expect(user().path(path, "link", "a")).resolves.toBeUndefined();
    for (const actor of [user(), admin()]) for (const op of ["write", "delete"] as const) await expect(actor.path(path, op)).rejects.toThrow(AccessDenied);
    await expect(user().path("generated/pf/la/other.pdf", "read")).rejects.toThrow(AccessDenied);
    await expect(user().path(path, "link", "b")).rejects.toThrow(AccessDenied);
    await expect(user().path("generated/pf/lb/premium-finance-agreement.pdf", "read")).rejects.toThrow(AccessDenied);
  });
  it("permits linking pending uploads but blocks document IDs from other accounts", async () => {
    records["Document:da"].s3Key = "pending";
    await expect(user().write("Document", "update", { id: "da", s3Key: "documents/ACCOUNT/a/da/new.pdf" })).resolves.toBeUndefined();
    await expect(user().path("documents/ACCOUNT/a/db/file.pdf", "write")).rejects.toThrow(AccessDenied);
    await expect(user().path("documents/ACCOUNT/a/da/other.pdf", "read")).rejects.toThrow(AccessDenied);
  });
  it("checks long file keys instead of treating them as absent IDs", async () => {
    await expect(user().write("Document", "update", { id: "da", s3Key: `generated/b/${"x".repeat(510)}.pdf` })).rejects.toThrow(AccessDenied);
  });
  it("rejects path traversal and unknown prefixes", async () => {
    for (const path of ["documents/../b/file.pdf", "generated/a/../b/file.pdf", "generated/a//f.pdf", "private/a/file", "templates/../file", "generated\\a\\file"]) await expect(user().path(path, "read")).rejects.toThrow(AccessDenied);
  });
  it("keeps templates shared", async () => {
    await expect(user().path("templates/acord.pdf", "read")).resolves.toBeUndefined();
    await expect(user().path("templates/acord.pdf", "write")).rejects.toThrow(AccessDenied);
    await expect(admin().path("templates/acord.pdf", "write")).resolves.toBeUndefined();
  });
  it.each(["read", "write", "delete", "link"] as const)("requires the signature owner or administrator for %s", async operation => {
    await expect(user().path("signatures/alice-profile.png", operation)).resolves.toBeUndefined();
    await expect(user().path("signatures/bob-profile.png", operation)).rejects.toThrow(AccessDenied);
    await expect(user("manager").path("signatures/alice-profile.png", operation)).rejects.toThrow(AccessDenied);
    await expect(admin().path("signatures/bob-profile.png", operation)).resolves.toBeUndefined();
    await expect(admin().path("signatures/missing.png", operation)).rejects.toThrow(AccessDenied);
  });
});
describe("custom API operations", () => {
  const call = (op: string, input: RecordData = {}, actor = user()) => authorizeCustom(actor, "communicationWrite", { operation: op, input: JSON.stringify(input) });
  it("cannot assign a foreign lead to yourself", async () => {
    await expect(call("setResponsibilities", { accountId: "b", salespersonId: "alice" })).rejects.toThrow(AccessDenied);
    await expect(call("setResponsibilities", { accountId: "a", salespersonId: "bob" })).rejects.toThrow(AccessDenied);
    await expect(call("setResponsibilities", { accountId: "a", salespersonId: "alice" })).resolves.toBeUndefined();
  });
  it("allows only administrators to create or reassign leads for another salesperson", async () => {
    await expect(call("createLead", { salespersonId: "alice" }, user("manager"))).rejects.toThrow(AccessDenied);
    await expect(call("createLead", { salespersonId: "bob" }, user("manager"))).rejects.toThrow(AccessDenied);
    await expect(call("createLead")).resolves.toBeUndefined();
    await expect(call("createLead", {}, user("manager"))).resolves.toBeUndefined();
    records["Communication:workflow:owned"] = { data: { salespersonId: "manager" } };
    await expect(call("setResponsibilities", { accountId: "owned", salespersonId: "alice" }, user("manager"))).rejects.toThrow(AccessDenied);
    await expect(call("setResponsibilities", { accountId: "a", salespersonId: "manager" }, user("manager"))).rejects.toThrow(AccessDenied);
    await expect(call("setResponsibilities", { accountId: "owned", salespersonId: "manager" }, user("manager"))).resolves.toBeUndefined();
    await expect(call("createLead", { salespersonId: "alice" }, admin())).resolves.toBeUndefined();
    await expect(call("setResponsibilities", { accountId: "owned", salespersonId: "alice" }, admin())).resolves.toBeUndefined();
  });
  it("denies former managers account, billing, task and conversation operations for prior reports", async () => {
    for (const [field, args] of [
      ["startLeadExtraction", { accountId: "a" }],
      ["sendInvoice", { invoiceId: "ia" }],
      ["servicePfLoan", { loanId: "la" }],
      ["communicationRead", { readOperation: "context", input: { accountId: "a" } }],
      ["communicationRead", { readOperation: "context", input: { conversationId: "cnv_a" } }],
      ["communicationWrite", { operation: "updateBlocker", input: { taskId: "task:a" } }],
    ] as const) {
      await expect(authorizeCustom(user("manager"), field, args)).rejects.toThrow(AccessDenied);
      await expect(authorizeCustom(admin(), field, args)).resolves.toBeUndefined();
    }
  });
  it("gates carrier, extraction and billing endpoints by account or stored parent", async () => {
    for (const field of ["startLeadExtraction", "suggestFormFields", "startHoneycombSubmission"]) {
      await expect(authorizeCustom(user(), field, { accountId: "b" })).rejects.toThrow(AccessDenied);
      await expect(authorizeCustom(user(), field, { accountId: "a" })).resolves.toBeUndefined();
    }
    await expect(authorizeCustom(user(), "startHoneycombSubmission", { accountId: "a", sourceEstimateId: "eb" })).rejects.toThrow(AccessDenied);
    await expect(authorizeCustom(user(), "sendInvoice", { invoiceId: "ib" })).rejects.toThrow(AccessDenied);
    await expect(authorizeCustom(user(), "servicePfLoan", { loanId: "la", policyId: "pb" })).rejects.toThrow(AccessDenied);
  });
  it("checks communication/task IDs and a conflicting account cannot override them", async () => {
    await expect(call("updateBlocker", { taskId: "task:b", accountId: "a" })).rejects.toThrow(AccessDenied);
    await expect(call("context", { conversationId: "cnv_b", accountId: "a" })).rejects.toThrow(AccessDenied);
    await expect(call("context", { conversationId: "unlinked" })).rejects.toThrow(AccessDenied);
    await expect(call("recordCallOutcome", { id: "task:a", taskId: "task:b" })).rejects.toThrow(AccessDenied);
    await expect(call("mergeTasks", { accountId: "a", tasks: [{ id: "task:b" }] })).rejects.toThrow(AccessDenied);
  });
  it("does not delegate work to someone who cannot view the account", async () => {
    await expect(call("delegateService", { taskId: "task:a", specialistId: "bob" })).rejects.toThrow(AccessDenied);
    await expect(call("delegateService", { taskId: "task:a", specialistId: "manager" })).rejects.toThrow(AccessDenied);
    await expect(call("delegateService", { taskId: "task:a", specialistId: "alice" })).resolves.toBeUndefined();
  });
  it("does not grant account, blocker or report access through a legacy specialist assignment", async () => {
    records["Communication:task:a"].data = { accountId: "a", specialistId: "bob", blocker: { ownerId: "bob" } };
    const specialist = user("bob");
    expect(await specialist.canAccount("a")).toBe(false);
    await expect(authorizeCustom(specialist, "communicationWrite", { operation: "updateBlocker", input: { taskId: "task:a" } })).rejects.toThrow(AccessDenied);
    const notice = { id: "notice:task:a:bob", accountId: "a", recipient: "bob" };
    expect(await filterCustom(specialist, "communicationRead", { readOperation: "work", input: { kind: "NOTIFICATION" } }, { items: [notice] })).toEqual({ items: [] });
    expect(await filterCustom(specialist, "communicationRead", { readOperation: "myReport" }, { report: { items: [{ id: "task:a", accountId: "a", stage: "DUE", role: "Specialist" }] } })).toEqual({ report: { items: [], accountCount: 0 } });
  });
  it("rejects administrative and unknown operations", async () => {
    for (const op of ["settings", "saveTeamRouting", "saveEligibility", "backfill", "unknown"]) await expect(call(op)).rejects.toThrow(AccessDenied);
    await expect(call("takeResponse", { taskId: "task:a", accountId: "a" })).rejects.toThrow(AccessDenied);
    await expect(authorizeCustom(user(), "futureEndpoint", {})).rejects.toThrow(AccessDenied);
  });
  it("filters work pages and preserves cursors even when a page is empty", async () => {
    const result = await filterCustom(user(), "communicationRead", { readOperation: "work" }, { ok: true, items: [{ id: "b", accountId: "b" }, { id: "unlinked" }], nextToken: "cursor" });
    expect(result).toEqual({ ok: true, items: [], nextToken: "cursor" });
  });
  it("filters stale daily reports and limits assignment choices", async () => {
    const result = await filterCustom(user(), "communicationRead", { readOperation: "myReport" }, { ok: true, report: { items: [{ accountId: "a" }, { accountId: "b" }], accountCount: 2 } });
    expect(result).toEqual({ ok: true, report: { items: [{ accountId: "a" }], accountCount: 1 } });
    const team = await filterCustom(user(), "communicationRead", { readOperation: "context" }, { team: [{ userId: "alice", salesperson: true }, { userId: "bob", salesperson: true }] });
    expect(team).toMatchObject({ actorId: "alice", team: [{ userId: "alice", salesperson: true }, { userId: "bob", salesperson: false }] });
  });
  it("preserves redacted operational alerts for the recipient without adding account access or inflating counts", async () => {
    const alert = { id: "issue:assignment:b", redacted: true, account: "Shared activity", title: "An account has a setup or assignment issue requiring administrator review.", stage: "EXCEPTION", section: "Setup and data", group: "Setup and data", url: "/lead-work" };
    const own = { id: "task:a", accountId: "a", stage: "DUE" };
    const report = { recipientId: "alice", items: [alert, own, { id: "task:b", accountId: "b" }], accountCount: 2 };
    expect(await filterCustom(user(), "communicationRead", { readOperation: "myReport" }, { report })).toEqual({ report: { ...report, items: [alert, own], accountCount: 1 } });
    expect(await user().canAccount("b")).toBe(false);
    await expect(call("context", { accountId: "b" })).rejects.toThrow(AccessDenied);
    const onlyAlert = { ...report, items: [alert] };
    for (const recipient of [user(), admin()]) expect(await filterCustom(recipient, "communicationRead", { readOperation: "myReport" }, { report: onlyAlert })).toMatchObject({ report: { items: [alert], accountCount: 0 } });
    expect(await filterCustom(user("manager"), "communicationRead", { readOperation: "myReport" }, { report: onlyAlert })).toMatchObject({ report: { items: [], accountCount: 0 } });
  });
  it("does not exempt unmarked or account-bearing rows from report access checks", async () => {
    const alert = { id: "issue:assignment:b", redacted: true, stage: "EXCEPTION", section: "Setup and data", group: "Setup and data", url: "/lead-work" };
    const items = [
      { ...alert, redacted: undefined }, { ...alert, redacted: "true" }, { ...alert, accountId: "b" },
      { ...alert, stage: "DUE" }, { ...alert, group: "Sales" }, { ...alert, section: "Your accounts today" },
      { ...alert, url: "/accounts/b" }, { ...alert, stage: "MANAGER" }, { id: "unlinked-task" },
    ];
    expect(await filterCustom(user(), "communicationRead", { readOperation: "myReport" }, { report: { recipientId: "alice", items } })).toEqual({ report: { recipientId: "alice", items: [], accountCount: 0 } });
  });
  it("removes retired management summaries, sections and takeover flags from legacy daily reports", async () => {
    records["Communication:workflow:owned"] = { data: { salespersonId: "manager" } };
    const own = { id: "own", accountId: "owned", stage: "DUE", section: "Your accounts today" };
    const foreign = { id: "foreign", accountId: "a", stage: "DUE", section: "Your accounts today" };
    const oldReport = {
      recipientId: "manager", sections: ["Your accounts today", "Your sales team today", "Needs your attention"],
      teamCounts: [{ name: "Alice", due: 10, overdue: 5 }], accountCount: 99,
      items: [{ ...own, canTakeResponse: true, verifiedEscalation: true }, foreign,
        { id: "old-manager", accountId: "owned", stage: "MANAGER", section: "Your sales team today" },
        { id: "old-owner", accountId: "owned", stage: "OWNER", section: "Needs your attention" },
        { id: "old-section", accountId: "owned", section: "Your sales team today" }],
    };
    const filtered = await filterCustom(user("manager"), "communicationRead", { readOperation: "myReport" }, { ok: true, report: oldReport });
    expect(filtered).toEqual({ ok: true, report: { recipientId: "manager", sections: ["Your accounts today"], items: [own], accountCount: 1 } });
    const adminReport = await filterCustom(admin(), "communicationRead", { readOperation: "myReport" }, { report: oldReport });
    expect(adminReport).toEqual({ report: { recipientId: "manager", sections: ["Your accounts today"], items: [own, foreign], accountCount: 2 } });
  });
  it("limits former managers' team assignment choices and account visibility to themselves", async () => {
    records["Communication:workflow:owned"] = { data: { salespersonId: "manager" } };
    const result = await filterCustom(user("manager"), "communicationRead", { readOperation: "context" }, {
      workflow: { accountId: "owned" }, team: [{ userId: "manager", salesperson: true }, { userId: "alice", salesperson: true }],
    });
    expect(result).toMatchObject({ actorId: "manager", team: [{ userId: "manager", salesperson: true, canAccessAccount: true }, { userId: "alice", salesperson: false, canAccessAccount: false }] });
  });
});
