import type { IntegrationConfig, LeadWorkflow, TeamEligibility, TeamRouting } from "../../../../shared/leadWorkflow";
import { salespersonEligibility, salespersonRouting, salespersonSettings } from "../../../../shared/salespersonOwnership";
import { get, query, row, save } from "./store";
import { ensureWorkflow } from "./workflow";

/** Bounded, restartable storage migration. Account ownership changes enqueue the
 * existing paginated role-sync job to move open work and automatic Front links.
 * Existing salespeople, deadlines, historical records and manual Front routing
 * are preserved; missing/disabled owners remain visible assignment exceptions. */
export async function migrateSalespersonOwnership() {
  const key = "migration:salesperson-ownership:v1";
  const old = await get<{ phase: "ELIGIBILITY" | "WORKFLOW"; cursor?: string; complete?: boolean }>(key);
  if (old?.data.complete) return;
  if (!old) {
    const routing = await get<TeamRouting>("team-routing");
    if (routing) await save(row("TEAM_ROUTING", routing.id, salespersonRouting(routing.data), { previous: routing }), routing);
    const config = await get<IntegrationConfig>("config");
    if (config) await save(row("CONFIG", config.id, salespersonSettings(config.data), { previous: config }), config);
  }
  const phase = old?.data.phase ?? "ELIGIBILITY";
  const page = await query<TeamEligibility | LeadWorkflow>("kind", phase, old?.data.cursor, 10);
  for (const candidate of page.items) {
    if (phase === "WORKFLOW") {
      const accountId = (candidate.data as LeadWorkflow).accountId;
      if (!await get(`deleted-account:${accountId}`)) await ensureWorkflow(accountId);
    }
    else {
      const member = await get<TeamEligibility>(candidate.id);
      if (member && "champion" in member.data) await save(row("ELIGIBILITY", member.id, salespersonEligibility(member.data), { previous: member }), member);
    }
  }
  await save(row("MIGRATION", key, { phase: !page.nextToken ? "WORKFLOW" : phase, cursor: page.nextToken, complete: phase === "WORKFLOW" && !page.nextToken }, { previous: old }), old);
}
