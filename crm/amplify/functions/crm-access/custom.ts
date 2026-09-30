import { AccountAccess } from "./access";
import { AccessDenied, id, object, type RecordData } from "./policy";
import { retiredTaskOperation } from "../../../../shared/retiredTaskOperations";
const adminCommunication = new Set(["dashboardOpenQuotesPage", "dashboardBoundPoliciesPage", "dashboardQuotesPage", "dashboardQuoteStates", "dashboardInvoiceAnchors", "dashboardAssignments", "dashboardInterestPage", "dashboardPolicyAnchors", "dashboardLeadPlansPage", "settings", "prepareLeadDeletion", "saveEligibility", "saveSettings", "restartReconciliation", "restartConversationHistory", "validateConnection", "activate", "reviewOperation", "backfill"]);
const accountOperations = new Set(["context", "accountSummary", "saveCommercial", "prepareBusinessDraft", "initializeLead", "setResponsibilities", "reopenLead", "setLeadDisposition", "cancelAi", "linkConversation", "linkActivity", "archive", "addNote"]);
async function filterAccountItems(access: AccountAccess, input: unknown) {
  const items = Array.isArray(input) ? input : [];
  await access.prefetchAccounts(items.map(value => id(object(value).accountId)));
  const permitted = await Promise.all(items.map(async value => await access.canAccount(id(object(value).accountId)) ? value : undefined));
  return permitted.filter(Boolean);
}
async function communicationAccount(access: AccountAccess, key: string, expected?: string) {
  const record = await access.get("Communication", key);
  const accountId = id(record?.accountId) || id(object(record?.data).accountId);
  await access.requireAccount(accountId);
  if (expected && expected !== accountId) throw new AccessDenied();
  return accountId;
}
export async function authorizeCustom(access: AccountAccess, field: string, args: RecordData) {
  if (["communicationRead", "communicationWrite"].includes(field) && retiredTaskOperation(id(args.readOperation ?? args.operation), object(args.input))) throw new AccessDenied();
  if (access.admin) return;
  if (["crmAccess", "crmFile", "honeycombSubmissionSettings", "reserveCertificateNumber", "reserveInvoiceNumber"].includes(field)) return;
  if (["startLeadExtraction", "suggestFormFields", "startHoneycombSubmission"].includes(field)) {
    await access.requireAccount(id(args.accountId));
    if (args.sourceEstimateId) {
      const estimate = await access.requireRecord("HoneycombEstimate", id(args.sourceEstimateId));
      if (estimate.accountId !== args.accountId) throw new AccessDenied();
    }
    return;
  }
  const model = ({ resolveHoneycombSubmission: ["HoneycombSubmission", "id"], sendInvoice: ["Invoice", "invoiceId"], voidInvoice: ["Invoice", "invoiceId"], issueFinanceQuote: ["Policy", "policyId"], generatePfAgreement: ["PfLoan", "loanId"], servicePfLoan: ["PfLoan", "loanId"] } as Record<string, string[]>)[field];
  if (model) {
    const record = await access.requireRecord(model[0], id(args[model[1]]));
    for (const [key, target] of Object.entries({ policyId: "Policy", noticeId: "PfNotice", boardResolutionDocumentId: "Document" })) if (args[key]) {
      const related = await access.requireRecord(target, id(args[key]));
      if (await access.root(target, related) !== await access.root(model[0], record)) throw new AccessDenied();
    }
    return;
  }
  if (!["communicationRead", "communicationWrite"].includes(field)) throw new AccessDenied();
  const op = id(args.readOperation ?? args.operation), input = object(args.input);
  if (adminCommunication.has(op)) throw new AccessDenied();
  if (["team", "smsComposer"].includes(op) && field === "communicationRead") return;
  if (op === "work" && field === "communicationRead") {
    if (!["WORKFLOW", "TRIAGE"].includes(id(input.kind))) throw new AccessDenied();
    return; // Returned pages are filtered by current assignment below.
  }
  if (op === "commercialTable") {
    if (!Array.isArray(input.accountIds) || input.accountIds.length > 25) throw new AccessDenied();
    await access.prefetchAccounts(input.accountIds.map(id));
    await Promise.all(input.accountIds.map(key => access.requireAccount(id(key)))); return;
  }
  if (op === "lastContacts") {
    if (!Array.isArray(input.accounts) || input.accounts.length > 10) throw new AccessDenied();
    await access.prefetchAccounts(input.accounts.map(entry => id(object(entry).accountId)));
    await Promise.all(input.accounts.map(entry => access.requireAccount(id(object(entry).accountId)))); return;
  }
  if (op === "createLead") {
    await access.requireSalesperson(id(input.salespersonId) || access.actor);
    const previous = await access.get("Communication", `manual:${access.actor}:${id(input.requestId)}`);
    if (previous) await access.requireAccount(id(object(previous.data).accountId));
    return;
  }
  let accountId = id(input.accountId);
  if (accountOperations.has(op) && accountId) await access.requireAccount(accountId);
  if (input.conversationId) accountId ||= await communicationAccount(access, `front-link:${id(input.conversationId)}`);
  if (input.conversationId) await communicationAccount(access, `front-link:${id(input.conversationId)}`, accountId);
  if (op === "context" || op === "routeConversation") { if (!accountId) throw new AccessDenied(); return; }
  if (op === "reviewIssue") { await communicationAccount(access, id(input.id), accountId); return; }
  if (["activity", "refreshSeen", "recordCallOutcome", "linkActivity"].includes(op)) {
    await communicationAccount(access, id(input.id), accountId);
    if (input.taskId) await communicationAccount(access, id(input.taskId), accountId);
    return;
  }
  if (op === "saveAttachment") { await communicationAccount(access, id(input.communicationId), accountId); return; }
  if (op === "authorizeBind") { await access.requireRecord("Quote", id(input.quoteId)); return; }
  if (!accountOperations.has(op) || !accountId) throw new AccessDenied();
  if (op === "setResponsibilities") await access.requireSalesperson(id(input.salespersonId));
  if (input.policyId) {
    const policy = await access.requireRecord("Policy", id(input.policyId));
    if (policy.accountId !== accountId) throw new AccessDenied();
  }
  if (op === "prepareBusinessDraft") {
    const target = ({ QUOTE: "Quote", DOCUMENT: "Document", CERTIFICATE: "Certificate" } as Record<string, string>)[id(input.kind)];
    if (!target) throw new AccessDenied();
    const record = await access.requireRecord(target, id(input.recordId));
    if (await access.root(target, record) !== accountId) throw new AccessDenied();
  }
}
export async function filterCustom(access: AccountAccess, field: string, args: RecordData, original: unknown) {
  if (field !== "communicationRead") return original;
  const result = object(original), op = id(args.readOperation);
  if (retiredTaskOperation(op, object(args.input))) throw new AccessDenied();
  if (access.admin) return op === "team" ? { ...result, actorId: access.actor } : original;
  if (op === "work") {
    return { ...result, items: await filterAccountItems(access, result.items) };
  }
  if (op === "team" || op === "context") {
    const allowed = await access.salespeople();
    const accountId = id(object(result.workflow).accountId);
    const team = await Promise.all((Array.isArray(result.team) ? result.team : []).map(async value => {
      const member = object(value), userId = id(member.userId);
      return { ...member, salesperson: member.salesperson === true && allowed.has(userId),
        ...(accountId ? { canAccessAccount: await new AccountAccess({ sub: userId }, (model, key) => access.get(model, key)).canAccount(accountId) } : {}) };
    }));
    return { ...result, actorId: access.actor, team };
  }
  return original;
}
