import { salespersonRouting } from "../../../../shared/salespersonOwnership";
import { taskRoute } from "../../../../shared/workRouting";
import type { TeamRouting, TeamEligibility, LeadTask, LeadWorkflow } from "../../../../shared/leadWorkflow";
import { get, save, row } from "./store";
import { team, enabledUser, UnavailableTeammateError } from "./workflow";

export async function routing(): Promise<TeamRouting> {
  const saved = await get<TeamRouting>("team-routing");
  return saved ? salespersonRouting({ ...saved.data, version: saved.version }) : { members: [], version: 0 };
}
export async function resolveTaskRoute(task: LeadTask, workflow: LeadWorkflow) {
  const settings = await routing(), members = await team();
  // Cache only successful enabled checks briefly. An identity-service error
  // remains an error; it can never be interpreted as a disabled teammate.
  for (let attempt = 0; attempt < members.length + 1; attempt++) {
    const route = taskRoute(task, workflow, settings, members);
    let changed = false;
    for (const id of new Set([route.recipientId].filter((s): s is string => !!s))) {
      if ((availability.get(id) ?? 0) > Date.now()) continue;
      try { await enabledUser(id); availability.set(id, Date.now() + 30_000); }
      catch(e) {
        if (!(e instanceof UnavailableTeammateError)) throw e;
        const m = members.find(m => m.userId === id); if (m) m.enabled = false;
        const old = await get<TeamEligibility>(`eligibility:${id}`);
        if (old?.data.enabled) await save(row("ELIGIBILITY", old.id, { ...old.data, enabled: false }, { previous: old }), old);
        changed = true;
      }
    }
    if (!changed) return route;
  }
  return taskRoute(task, workflow, settings, members);
}
const availability = new Map<string, number>();
export async function saveRouting(input: TeamRouting, actor: string, roster?: TeamEligibility[]) {
  void input; void actor; void roster;
  throw new Error("Daily staff report settings have been removed from the CRM.");
}

export async function resolveIssue(id: string) {
  const old = await get(`issue:${id}`);
  if (old && !old.data.resolved) await save(row("ISSUE", old.id, { ...old.data, resolved: true, resolvedAt: new Date().toISOString() }, { previous: old, accountId: old.accountId }), old);
}
