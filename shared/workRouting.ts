import type { LeadTask, LeadWorkflow, TeamEligibility, TeamRouting, Responsibility, WorkDomain, BusinessContext } from "./leadWorkflow";

export function taskDomain(task: Pick<LeadTask, "domain" | "kind" | "role">): WorkDomain {
  return task.domain ?? (task.kind === "CARRIER" || task.role === "CHAMPION" && task.kind === "FOLLOW_UP" ? "CARRIER" : "CLIENT");
}
export function taskContext(task: Pick<LeadTask, "context">): BusinessContext { return task.context ?? "LEAD"; }
export function accountableRole(task: LeadTask): Responsibility {
  return task.accountableRole ?? (taskContext(task) === "LEAD" && taskDomain(task) === "CLIENT" ? "SALESPERSON" : "CHAMPION");
}
export function taskRoute(task: LeadTask, workflow: LeadWorkflow, routing: TeamRouting, team: TeamEligibility[], now = new Date().toISOString()) {
  const role = accountableRole(task);
  const accountableId = role === "SALESPERSON" ? workflow.salespersonId : workflow.championId;
  const active = (id?: string) => !!id && team.some(m => m.userId === id && m.enabled);
  const cover = (id?: string, visited = new Set<string>()): string | undefined => {
    if (!id) return;
    if (visited.has(id)) return;
    visited.add(id);
    const settings = routing.members.find(m => m.userId === id);
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
    const scheduledAway = settings?.coverFrom && settings.coverThrough && settings.coverFrom <= day && day <= settings.coverThrough;
    if (settings?.away || scheduledAway || !active(id)) return cover(settings?.coverId, visited);
    return id;
  };
  const assigneeId = task.specialistId ?? task.helperId ?? accountableId;
  const configuredManager = role === "SALESPERSON" ? routing.members.find(m => m.userId === accountableId)?.salesManagerId : routing.marketingManagerId;
  const ownerId = cover(routing.ownerId);
  const managerCover = configuredManager === accountableId ? routing.members.find(m => m.userId === configuredManager)?.coverId : undefined;
  const managerId = configuredManager === accountableId ? cover(managerCover) ?? ownerId : cover(configuredManager) ?? ownerId;
  const recipientId = cover(assigneeId) ?? managerId ?? ownerId;
  const gaps = [!cover(assigneeId) && "Arrange coverage for the responsible teammate", !cover(configuredManager) && accountableId !== routing.ownerId && "Choose an available manager", !ownerId && "Choose an available agency owner"].filter((s): s is string => !!s);
  return { accountableId, assigneeId, recipientId, managerId, ownerId, role, gaps };
}

/** Validate the entire graph together, so concurrent edits cannot create cycles. */
export function validateRouting(routing: TeamRouting, team: TeamEligibility[]) {
  if (!Array.isArray(routing.members) || routing.members.length > 500) throw new Error("Choose valid team relationships");
  if (new Set(routing.members.map(m => m.userId)).size !== routing.members.length) throw new Error("A teammate can appear only once");
  const members = new Map(team.map(m => [m.userId, m]));
  const requireMember = (id?: string) => { if (id && !members.get(id)?.enabled) throw new Error("Choose an enabled CRM teammate"); };
  for (const id of [routing.ownerId, routing.marketingManagerId, routing.intakeOwnerId, routing.integrationOwnerId]) requireMember(id);
  if (routing.marketingManagerId && !routing.members.some(m => m.userId === routing.marketingManagerId && m.marketingManager)) throw new Error("Enable the marketing manager in Team settings");
  for (const m of routing.members) {
    requireMember(m.userId); requireMember(m.salesManagerId); requireMember(m.coverId);
    if (m.salesManagerId === m.userId || m.coverId === m.userId) throw new Error("Choose another person as manager or cover");
    if (m.salesManagerId && !routing.members.some(r => r.userId === m.salesManagerId && r.salesManager)) throw new Error("Choose an eligible sales manager");
    if (m.coverFrom || m.coverThrough) {
      const valid = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v;
      if (!valid(m.coverFrom) || !valid(m.coverThrough) || m.coverFrom! > m.coverThrough! || !m.coverId) throw new Error("Choose a cover and valid start/end dates");
    }
    if (m.coverId) {
      const source = members.get(m.userId)!, target = members.get(m.coverId)!;
      if (source.salesperson && !target.salesperson || source.champion && !target.champion) throw new Error("Cover must be eligible for the teammate's responsibilities");
      const targetRole = routing.members.find(r => r.userId === m.coverId);
      if (m.salesManager && !targetRole?.salesManager || m.marketingManager && !targetRole?.marketingManager) throw new Error("Manager cover must be eligible for the same management role");
      if (targetRole?.away) throw new Error("Cover must be available");
    }
    for (const field of ["salesManagerId", "coverId"] as const) {
      const visited = new Set([m.userId]); let id = m[field];
      while (id) { if (visited.has(id)) throw new Error("Team relationships cannot form a loop"); visited.add(id); id = routing.members.find(r => r.userId === id)?.[field]; }
    }
  }
  if (routing.reportChannelId && !/^cha_[a-z0-9]+$/.test(routing.reportChannelId)) throw new Error("Choose a valid internal reporting channel");
}
