import { taskWakeAt, type Communication, type LeadTask } from '../../../../shared/leadWorkflow';
import type { ConversationLink } from './events';
import { get, row, put, commit, check } from './store';
import { accountRows } from './workflow';

/** Reclassify open correspondence, preserving its original deadline and evidence.
 * A durable lifecycle job repeats this if a concurrent message interrupts repair. */
export async function repairConversationContexts(accountId: string) {
  const links = new Map((await accountRows<ConversationLink>(accountId, 'LINK')).map(l => [l.data.conversationId, l]));
  for (const candidate of await accountRows<LeadTask>(accountId, 'TASK')) {
    const t = await get<LeadTask>(candidate.id);
    if (!t || t.data.status !== 'OPEN' || !t.data.conversationId || t.data.milestone || t.data.parentTaskId) continue;
    const link = links.get(t.data.conversationId); if (!link || !link.data.context) continue;
    const { context, policyId, quoteId } = link.data;
    const domain = link.data.purpose === 'CARRIER' ? 'CARRIER' : 'CLIENT';
    const role = domain === 'CARRIER' || context !== 'LEAD' ? 'CHAMPION' : 'SALESPERSON';
    const kind = t.data.kind === 'RESPONSE' && domain === 'CARRIER' ? 'CARRIER' : t.data.kind === 'CARRIER' && domain === 'CLIENT' ? 'RESPONSE' : t.data.kind;
    if (t.data.context === context && t.data.domain === domain && t.data.role === role && t.data.policyId === policyId && t.data.quoteId === quoteId && t.data.kind === kind) continue;
    const data: LeadTask = { ...t.data, context, domain, role, kind, policyId, quoteId, accountableRole: role, helperId: undefined, specialistId: undefined, helperRequestedBy: undefined, helperReason: undefined, version: t.version + 1 };
    await commit([check(link), put(row('TASK', t.id, data, { accountId, previous: t, dueAt: taskWakeAt(data) }), t)]);
  }
  for (const candidate of await accountRows<Communication>(accountId, 'COMMUNICATION')) {
    const c = await get<Communication>(candidate.id);
    const link = c?.data.conversationId ? links.get(c.data.conversationId) : undefined;
    if (!c || !link || !link.data.context) continue;
    if (c.data.purpose === link.data.purpose && c.data.context === link.data.context && c.data.policyId === link.data.policyId && c.data.quoteId === link.data.quoteId) continue;
    await commit([check(link), put(row('COMMUNICATION', c.id, { ...c.data, purpose: link.data.purpose, context: link.data.context, policyId: link.data.policyId, quoteId: link.data.quoteId }, { accountId, previous: c, dueAt: c.dueAt }), c)]);
  }
}
