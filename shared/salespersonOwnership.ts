import type { IntegrationConfig, LeadTask, LeadWorkflow, TeamEligibility, TeamRouting } from "./leadWorkflow";

/** Keep legacy fields readable for migration, but never expose them as active roles. */
export function salespersonWorkflow(input: LeadWorkflow): LeadWorkflow {
  const { championId: _retired, ...workflow } = input;
  return workflow;
}
export function salespersonEligibility(input: TeamEligibility): TeamEligibility {
  const { champion: _retired, ...member } = input;
  return member;
}
export function salespersonSettings(input: IntegrationConfig): IntegrationConfig {
  const { defaultChampionId: _retired, ...settings } = input;
  return settings;
}
export function salespersonRouting(input: TeamRouting): TeamRouting {
  const { marketingManagerId: _retired, ...routing } = input;
  return { ...routing, members: routing.members.map(({ marketingManager: _removed, ...member }) => member) };
}
export function salespersonTask(input: LeadTask): LeadTask {
  // Infer the old carrier domain before removing its role. Preserve IDs, dates,
  // context and evidence so existing follow-ups cannot turn into client chases.
  const task = { ...input, domain: input.domain ?? (input.kind === "CARRIER" || input.role === "CHAMPION" && input.kind === "FOLLOW_UP" ? "CARRIER" : "CLIENT"), role: "SALESPERSON", accountableRole: "SALESPERSON" } as LeadTask;
  if (task.helperReason === "SALES_ASSIST") {
    delete task.helperId; delete task.helperRequestedBy; delete task.helperReason;
  }
  return task;
}
