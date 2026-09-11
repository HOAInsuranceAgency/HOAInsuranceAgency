import { taskRoute, validateRouting } from "../../../../shared/workRouting";
import type { TeamRouting, TeamEligibility, LeadTask, LeadWorkflow } from "../../../../shared/leadWorkflow";
import { get, save, row, commit, put, audit } from "./store";
import { team, enabledUser, UnavailableTeammateError } from "./workflow";

export async function routing(): Promise<TeamRouting> {
  const saved = await get<TeamRouting>("team-routing");
  return saved ? { ...saved.data, version: saved.version } : { members: [], version: 0 };
}
export async function resolveTaskRoute(task: LeadTask, workflow: LeadWorkflow) {
  const settings = await routing(), members = await team();
  // Cache only successful enabled checks briefly. An identity-service error
  // remains an error; it can never be interpreted as a disabled teammate.
  for (let attempt = 0; attempt < members.length + 1; attempt++) {
    const route = taskRoute(task, workflow, settings, members);
    let changed = false;
    for (const id of new Set([route.recipientId, route.managerId, route.ownerId].filter((s): s is string => !!s))) {
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
  const old = await get<TeamRouting>("team-routing");
  if (input.version !== (old?.version ?? 0)) throw new Error("Team settings changed. Refresh before saving.");
  const members = roster ?? await team(); validateRouting(input, members);
  const ids = new Set([input.ownerId, input.marketingManagerId, input.intakeOwnerId, input.integrationOwnerId, ...input.members.flatMap(m => [m.userId, m.salesManagerId, m.coverId])].filter((id): id is string => !!id));
  for (const id of ids) await enabledUser(id);
  if (input.reportChannelId) await (await import("./reports")).verifyReportChannel(input.reportChannelId);
  // Manager-only teammates need a server-owned directory entry, with no producer eligibility added.
  for (const id of ids) if (!await get(`eligibility:${id}`)) {
    const member = members.find(m => m.userId === id)!;
    await save(row("ELIGIBILITY", `eligibility:${id}`, { ...member, salesperson: false, champion: false, enabled: true }));
  }
  const next = row("TEAM_ROUTING", "team-routing", { ...input, version: (old?.version ?? 0) + 1 }, { previous: old });
  await commit([put(next, old), audit("TEAM", actor, "Managers and coverage updated", input)]);
  return next.data;
}
export async function resolveIssue(id: string) {
  const old = await get(`issue:${id}`);
  if (old && !old.data.resolved) await save(row("ISSUE", old.id, { ...old.data, resolved: true, resolvedAt: new Date().toISOString() }, { previous: old, accountId: old.accountId }), old);
}
