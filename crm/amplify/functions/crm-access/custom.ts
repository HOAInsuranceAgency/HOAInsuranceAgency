import { AccountAccess } from "./access";
import { AccessDenied, id, object, type RecordData } from "./policy";
const adminCommunication = new Set(["settings", "reportDelivery", "prepareLeadDeletion", "recoverReport", "saveTeamRouting", "saveEligibility", "saveSettings", "restartReconciliation", "restartConversationHistory", "validateConnection", "activate", "reviewOperation", "backfill"]);
const accountOperations = new Set(["context", "accountSummary", "nextYearPreview", "saveCommercial", "prepareBusinessDraft", "nextYear", "initializeLead", "setResponsibilities", "reopenLead", "setLeadDisposition", "cancelAi", "linkConversation", "linkActivity", "archive", "addNote", "mergeTasks"]);
const taskOperations = new Set(["deliveryOptions", "updateBlocker", "takeResponse", "delegateService", "requestProspectInformation"]);
async function communicationAccount(access: AccountAccess, key: string, expected?: string) {
  const record = await access.get("Communication", key);
  const accountId = id(record?.accountId) || id(object(record?.data).accountId);
  await access.requireAccount(accountId);
  if (expected && expected !== accountId) throw new AccessDenied();
  return accountId;
}
export async function authorizeCustom(access: AccountAccess, field: string, args: RecordData) {
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
  if (["team", "teamRouting", "smsComposer", "myReport"].includes(op) && field === "communicationRead") return;
  if (op === "work" && field === "communicationRead") {
    if (!["TASK", "WORKFLOW", "NOTIFICATION", "TRIAGE"].includes(id(input.kind) || "TASK")) throw new AccessDenied();
    return; // Returned pages are filtered by current assignment below.
  }
  if (op === "commercialTable") {
    if (!Array.isArray(input.accountIds) || input.accountIds.length > 25) throw new AccessDenied();
    await Promise.all(input.accountIds.map(key => access.requireAccount(id(key)))); return;
  }
  if (op === "lastContacts") {
    if (!Array.isArray(input.accounts) || input.accounts.length > 10) throw new AccessDenied();
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
  if (taskOperations.has(op)) {
    const account = await communicationAccount(access, id(input.taskId), accountId);
    if (op === "delegateService") {
      const recipient = new AccountAccess({ sub: id(input.specialistId) }, (model, key) => access.get(model, key));
      await recipient.requireAccount(account);
    }
    return;
  }
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
  if (op === "mergeTasks") {
    if (!Array.isArray(input.tasks) || input.tasks.length > 10) throw new AccessDenied();
    await Promise.all(input.tasks.map(task => communicationAccount(access, id(object(task).id), accountId)));
  }
}
export async function filterCustom(access: AccountAccess, field: string, args: RecordData, original: unknown) {
  if (field !== "communicationRead") return original;
  const result = object(original), op = id(args.readOperation);
  if (access.admin) return op === "team" ? { ...result, actorId: access.actor } : original;
  if (op === "work") {
    const permitted = await Promise.all((Array.isArray(result.items) ? result.items : []).map(async value => await access.canAccount(id(object(value).accountId)) ? value : undefined));
    return { ...result, items: permitted.filter(Boolean) };
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
  if (op === "myReport") {
    const report = object(result.report);
    const permitted = await Promise.all((Array.isArray(report.items) ? report.items : []).map(async value => await access.canAccount(id(object(value).accountId)) ? value : undefined));
    const items = permitted.filter(Boolean);
    return { ...result, report: { ...report, items, accountCount: new Set(items.map(i => object(i).accountId)).size } };
  }
  return original;
}
