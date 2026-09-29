import type { LeadTask, LeadWorkflow, TeamEligibility, TeamRouting, Responsibility, WorkDomain, BusinessContext } from "./leadWorkflow";

export function taskDomain(task: Pick<LeadTask, "domain" | "kind" | "role">): WorkDomain {
  return task.domain ?? (task.kind === "CARRIER" || task.role === "CHAMPION" && task.kind === "FOLLOW_UP" ? "CARRIER" : "CLIENT");
}
export function taskContext(task: Pick<LeadTask, "context">): BusinessContext { return task.context ?? "LEAD"; }
export function accountableRole(task: LeadTask): Responsibility {
  void task;
  return "SALESPERSON";
}
export function taskRoute(task: LeadTask, workflow: LeadWorkflow, _routing: TeamRouting, team: TeamEligibility[], _now?: string) {
  const role = accountableRole(task), accountableId = workflow.salespersonId;
  const eligibleSalesperson = team.some(m => m.userId === accountableId && m.salesperson && m.enabled) ? accountableId : undefined;
  const assigneeId = task.blocker?.ownerId ?? task.specialistId ?? eligibleSalesperson;
  // Specialist/blocker metadata preserves business context, never account access.
  const recipientId = eligibleSalesperson;
  const gaps = recipientId ? [] : ["Assign an enabled salesperson to this account"];
  return { accountableId, assigneeId, recipientId, role, gaps };
}

/** Only operational delivery contacts are configurable. Legacy relationships are ignored. */
export function validateRouting(routing: TeamRouting, team: TeamEligibility[]) {
  const members = new Map(team.map(m => [m.userId, m]));
  for (const id of [routing.ownerId, routing.intakeOwnerId, routing.integrationOwnerId]) {
    if (id && !members.get(id)?.enabled) throw new Error("Choose an enabled CRM teammate");
  }
  if (routing.reportChannelId && !/^cha_[a-z0-9]+$/.test(routing.reportChannelId)) throw new Error("Choose a valid internal reporting channel");
}

/** Incomplete drafts are allowed during setup; active delivery needs a report issues contact. */
export function validateCompleteRouting(routing: TeamRouting, team: TeamEligibility[]) {
  if (!routing.ownerId || !routing.reportChannelId) throw new Error("Choose the report issues contact and internal report channel in Team settings");
  validateRouting(routing, team);
}
