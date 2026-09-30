import { type Communication } from '../../../../shared/leadWorkflow';
import type { ConversationLink } from './events';
import { get, row, put, commit, check } from './store';
import { accountRows } from './workflow';

/** Reclassify open correspondence, preserving its original deadline and evidence.
 * A durable lifecycle job repeats this if a concurrent message interrupts repair. */
export async function repairConversationContexts(accountId: string) {
  const links = new Map((await accountRows<ConversationLink>(accountId, 'LINK')).map(l => [l.data.conversationId, l]));
  for (const candidate of await accountRows<Communication>(accountId, 'COMMUNICATION')) {
    const c = await get<Communication>(candidate.id);
    const link = c?.data.conversationId ? links.get(c.data.conversationId) : undefined;
    if (!c || !link || !link.data.context) continue;
    if (c.data.purpose === link.data.purpose && c.data.context === link.data.context && c.data.policyId === link.data.policyId && c.data.quoteId === link.data.quoteId) continue;
    await commit([check(link), put(row('COMMUNICATION', c.id, { ...c.data, purpose: link.data.purpose, context: link.data.context, policyId: link.data.policyId, quoteId: link.data.quoteId }, { accountId, previous: c, dueAt: c.dueAt }), c)]);
  }
}
