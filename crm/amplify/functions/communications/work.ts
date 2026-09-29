import { tasksRemoved, currentCommunicationIssue, retiredReminderOperation } from "./retiredTasks";
import { get, query, type Row } from "./store";
import type { LeadWorkflow } from "../../../../shared/leadWorkflow";

/** Fill a page of matching work, not one page of arbitrary global records. */
export async function workPage(input: { kind: string; view?: string; responsibility?: string; mine?: boolean; actor: string; nextToken?: string }) {
  if (!input.kind?.trim() || ["TASK", "NOTIFICATION"].includes(input.kind.trim())) tasksRemoved();
  const items: Row[] = [];
  let nextToken = input.nextToken;
  const owners = new Map<string, LeadWorkflow | undefined>();
  // A bounded search always returns its cursor. The UI must say "continue
  // searching" rather than "no work" when this budget is reached.
  for (let pageNumber = 0; pageNumber < 8; pageNumber++) {
    const page = await query("work", input.kind, nextToken, 50 - items.length);
    if (input.mine) await Promise.all([...new Set(page.items.flatMap(r => r.accountId && !owners.has(r.accountId) ? [r.accountId] : []))].map(async id => owners.set(id, (await get<LeadWorkflow>(`workflow:${id}`))?.data)));
    const issueVisibility = input.kind === "ISSUE" ? await Promise.all(page.items.map(r => currentCommunicationIssue(r, get))) : undefined;
    for (const [index, r] of page.items.entries()) {
      if (issueVisibility && !issueVisibility[index]) continue;
      const t = r.data;
      if (input.kind === "OPERATION" && retiredReminderOperation(r.id, t)) continue;
      if (t.resolved || t.processedAt || ["CONFIRMED", "SUPPRESSED"].includes(String(t.state))) continue;
      if (input.mine && owners.get(r.accountId ?? "")?.salespersonId !== input.actor && t.recipient !== input.actor) continue;
      items.push({ ...r, data: t });
    }
    nextToken = page.nextToken;
    if (!nextToken || items.length === 50) break;
  }
  return { items, nextToken };
}
