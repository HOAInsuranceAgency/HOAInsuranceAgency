import { currentCommunicationIssues, retiredReminderOperation } from "./retiredTasks";
import { type Communication } from "../../../../shared/leadWorkflow";
import { batchGet, get } from "./store";
import { config } from "./config";
import { accountRows, ensureWorkflow, enabledUser } from "./workflow";
import { front, permittedConversation, type FrontMessage } from "./providers";
/** Recheck immediately before Front cleanup. Any uncertainty keeps work visible. */
export async function archiveAllowed(accountId: string, conversationId: string) {
  const c = await config();
  if (!c.activatedAt || c.paused) return false;
  const [wf, activity, issues, health, conversation] = await Promise.all([
    ensureWorkflow(accountId), accountRows<Communication>(accountId, "COMMUNICATION"),
    accountRows<{ resolved?: boolean; sourceId?: string }>(accountId, "ISSUE"), get<{ at: string; lagging: boolean }>("health:worker"), permittedConversation(conversationId),
  ]);
  const pending = await accountRows<{ state: string; type: string }>(accountId, "OPERATION");
  const sendUncertain = pending.some(o => !retiredReminderOperation(o.id, o.data) && ["EMAIL", "IMPORT", "COMMENT"].includes(o.data.type) && !["CONFIRMED", "SUPPRESSED"].includes(o.data.state));
  const syncGap = await get<{ resolved?: boolean }>("issue:sync-gap");
  const relevantIssues = await currentCommunicationIssues(issues, batchGet);
  const unhealthy = sendUncertain || !!(syncGap && !syncGap.data.resolved) || !health || health.data.lagging || Date.now() - Date.parse(health.data.at) > 300_000 || relevantIssues.some(Boolean);
  const unresolved = activity.some(r => !r.data.resolved && (r.data.direction === "INBOUND" && r.data.classification !== "AUTOMATIC" || r.data.channel === "CALL" && !r.data.outcome));
  if (!wf.data.salespersonId || wf.data.assignmentIssue || unresolved || unhealthy) return false;
  try { await enabledUser(wf.data.salespersonId!); } catch { return false; }
  // An inbound event may still be in transit. Front's current last message must
  // already be accounted for, not merely absent from the CRM task list.
  const last = conversation.last_message ?? (await front<{ _results: FrontMessage[] }>(`/conversations/${conversation.id}/messages?limit=1`))._results[0];
  if (last?.is_draft) return false;
  if (last) {
    const known = await get<Communication>(`comm:front:${last.id}`);
    if (!known || last.is_inbound && !known.data.resolved && known.data.classification !== "AUTOMATIC") return false;
  }
  return true;
}
