import type { IntegrationConfig, LeadWorkflow, TeamEligibility, TeamRouting } from "./leadWorkflow";

/** Assignment choices require both configured eligibility and current availability. */
export function isAssignableSalesperson(member: TeamEligibility): boolean {
  return member.enabled && member.salesperson && member.available === true;
}

/** Infer a legacy pause only for a current Producer; preserve explicit preferences across role changes. */
export function receivesNewLeads(member: Pick<TeamEligibility, "receiveNewLeads" | "salesperson"> | undefined, currentProducer: boolean): boolean {
  return member?.receiveNewLeads ?? !(currentProducer && member?.salesperson === false);
}

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
  const { version, ownerId, intakeOwnerId, integrationOwnerId, reportChannelId } = input;
  return { version, ownerId, intakeOwnerId, integrationOwnerId, reportChannelId, members: [] };
}
