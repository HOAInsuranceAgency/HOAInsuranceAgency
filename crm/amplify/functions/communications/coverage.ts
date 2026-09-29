import type { LeadWorkflow } from "../../../../shared/leadWorkflow";
import { scopeLegacyQuotes } from "../../../../shared/renewalPolicy";
import { alternativeQuoteIds, type CommercialPlan } from "../../../../shared/quotePackages";
import { dataClient } from "./data";
import { operationRow } from "./outbox";
import type { ConversationLink } from "./events";
import { get, row, save, put, commit, check, issue, type Row } from "./store";
import { accountRows, ensureWorkflow } from "./workflow";
import { resolveIssue } from "./routing";

type Account = { id: string; name: string; stage?: string | null; currentPolicyExpiration?: string | null; createdAt: string; updatedAt: string };
async function all<T>(fetch: (nextToken?: string) => Promise<{ data: T[]; errors?: unknown[]; nextToken?: string | null }>) {
  const items: T[] = []; let cursor: string | undefined;
  do { const p = await fetch(cursor); if (p.errors?.length) throw new Error("Account records could not be verified"); items.push(...p.data); cursor = p.nextToken ?? undefined; } while (cursor);
  return items;
}

/** Preserve quote/package context and the real post-bind conversation handoff. */
export async function reconcileAccountWork(account: Account, workflow?: Row<LeadWorkflow>) {
  if (await get(`deleted-account:${account.id}`)) return;
  await (await import("./conversationContext")).repairConversationContexts(account.id);
  let wf = workflow ?? await ensureWorkflow(account.id);
  const sourceAccount = await (await dataClient()).models.Account.get({ id: account.id });
  if (sourceAccount.errors?.length || !sourceAccount.data) throw new Error("Could not load this account's records");
  const related = sourceAccount.data;
  const [rawQuotes, policies] = await Promise.all([
    all(token => related.quotes({ nextToken: token, limit: 100 })),
    all(token => related.policies({ nextToken: token, limit: 100 })),
  ]);
  const commercial = await get<CommercialPlan>(`commercial:${account.id}`), alternativeIds = alternativeQuoteIds(commercial?.data);
  const selectedPackage = commercial?.data.options.find(o => o.id === commercial.data.selectedOptionId);
  const { quotes, ambiguous } = scopeLegacyQuotes(rawQuotes.filter(q => q.status === 'BOUND' || !alternativeIds.includes(q.id)), policies);
  if (ambiguous.length) await issue(`renewal-context:${account.id}`, "Choose which expiring policy the ambiguous renewal quotes replace", account.id); else await resolveIssue(`renewal-context:${account.id}`);
  const pendingLead = [...new Set([...quotes.filter(q => ["DRAFT", "SUBMITTED", "QUOTED", "PRESENTED"].includes(q.status) && !q.renewalPolicyId && !policies.some(p => p.quoteId === q.id)).map(q => q.id), ...(selectedPackage?.quoteIds.filter(id => !rawQuotes.some(q => q.id === id && q.status === 'BOUND') || !policies.some(p => p.quoteId === id)) ?? [])])];
  if (JSON.stringify(wf.data.openLeadQuoteIds ?? []) !== JSON.stringify(pendingLead)) wf = await save(row("WORKFLOW", wf.id, { ...wf.data, openLeadQuoteIds: pendingLead, version: wf.version + 1 }, { accountId: account.id, previous: wf }), wf);
  if (wf.data.disposition === "BOUND" && !pendingLead.length) {
    for (const link of await accountRows<ConversationLink>(account.id, "LINK")) {
      if (link.data.context && link.data.context !== "LEAD") continue;
      const nextRouting = link.data.routing === "MANUAL" ? "MANUAL" : "SALESPERSON";
      const operationId = `op:client-handoff:${link.id}:${link.version}`;
      await commit([check(wf), put(row("LINK", link.id, { ...link.data, context: "SERVICE", routing: nextRouting }, { accountId: account.id, previous: link }), link), ...(nextRouting !== "MANUAL" ? [put(operationRow(operationId, { type: "ASSIGN", accountId: account.id, conversationId: link.data.conversationId }))] : [])]);
    }
  }
}

/** Compatibility entry point: the retired task census performs no reads or writes. */
export async function coverageSweep() { return { retired: true }; }
