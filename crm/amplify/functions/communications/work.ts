import { get, query, type Row } from "./store";
import type { LeadWorkflow } from "../../../../shared/leadWorkflow";
import { needsAttention } from "../../../../shared/leadWorkViews";
const day = (value: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));

/** Fill a page of matching work, not one page of arbitrary global records. */
export async function workPage(input: { kind: string; view?: string; responsibility?: string; mine?: boolean; actor: string; nextToken?: string }) {
  const items: Row[] = [], now = new Date().toISOString();
  let nextToken = input.nextToken;
  const owners = new Map<string, LeadWorkflow | undefined>();
  // A bounded search always returns its cursor. The UI must say "continue
  // searching" rather than "no work" when this budget is reached.
  for (let pageNumber = 0; pageNumber < 8; pageNumber++) {
    const page = await query("work", input.kind, nextToken, 50 - items.length);
    if (input.mine) await Promise.all([...new Set(page.items.flatMap(r => r.accountId && !owners.has(r.accountId) ? [r.accountId] : []))].map(async id => owners.set(id, (await get<LeadWorkflow>(`workflow:${id}`))?.data)));
    for (const r of page.items) {
      const t = r.data;
      if (t.resolved || t.processedAt || ["CONFIRMED", "SUPPRESSED"].includes(String(t.state))) continue;
      if (input.kind === "NOTIFICATION" && t.recipient !== input.actor) continue;
      if (input.mine) {
        const wf = owners.get(r.accountId ?? "");
        if (input.responsibility === "SALESPERSON" ? wf?.salespersonId !== input.actor
          : input.responsibility === "CHAMPION" ? wf?.championId !== input.actor
          : wf?.salespersonId !== input.actor && wf?.championId !== input.actor && t.recipient !== input.actor) continue;
      }
      if (input.kind === "TASK") {
        if (t.status !== "OPEN") continue;
        if (input.responsibility && t.role !== input.responsibility) continue;
        if (input.view === "Needs attention" && !needsAttention(t, now)) continue;
        if (input.view === "Upcoming" && needsAttention(t, now)) continue;
        if (input.view === "Needs response" && !["RESPONSE", "CALLBACK"].includes(String(t.kind))) continue;
        if (input.view === "Overdue" && String(t.dueAt) >= now) continue;
        if (input.view === "Due today" && day(String(t.dueAt)) !== day(now)) continue;
        if (input.view === "Waiting on prospect" && t.kind !== "FOLLOW_UP") continue;
        if (input.view === "Champion work" && t.role !== "CHAMPION") continue;
      }
      items.push(r);
    }
    nextToken = page.nextToken;
    if (!nextToken || items.length === 50) break;
  }
  return { items, nextToken };
}
