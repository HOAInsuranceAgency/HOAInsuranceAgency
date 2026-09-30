import type { LeadWorkflow, TeamEligibility } from "../../../../shared/leadWorkflow";
import { check, get, put, row, type Write } from "../communications/store";
import { enabledUser, team, UnavailableTeammateError } from "../communications/workflow";

const ROTATION_ID = "rotation:web-leads";

/** The cursor advances only in the transaction that durably captures the lead. */
export async function prepareWebLeadAssignment(accountId: string, name: string): Promise<{ workflow: LeadWorkflow; writes: Write[] }> {
  const workflow: LeadWorkflow = { accountId, name, ownershipModel: "SALESPERSON", disposition: "ACTIVE", version: 1, updatedAt: new Date().toISOString() };
  try {
    const [cursor, members] = await Promise.all([get<{ lastUserId: string }>(ROTATION_ID), team()]);
    const ids = [...new Set(members.filter(member => member.enabled && member.salesperson).map(member => member.userId))].sort();
    // Continue after a removed/disabled member as well as after a current one.
    const after = ids.findIndex(id => id > (cursor?.data.lastUserId ?? ""));
    const start = after === -1 ? 0 : after;
    for (let offset = 0; offset < ids.length; offset++) {
      const userId = ids[(start + offset) % ids.length];
      // The directory index is eventually consistent. Re-read the actual row
      // and guard its version in the same transaction as the assignment.
      const member = await get<TeamEligibility>(`eligibility:${userId}`);
      if (!member?.data.enabled || !member.data.salesperson) continue;
      try { await enabledUser(userId); }
      catch (error) { if (error instanceof UnavailableTeammateError) continue; throw error; }
      workflow.salespersonId = userId;
      return { workflow, writes: [
        put(row("CURSOR", ROTATION_ID, { lastUserId: userId }, { previous: cursor }), cursor),
        check(member),
      ] };
    }
    workflow.assignmentIssue = "No active salesperson is available for website leads. Enable a salesperson in Team settings and assign this lead.";
  } catch (error) {
    console.error("Website lead assignment could not be verified", error instanceof Error ? error.name : "unknown");
    workflow.assignmentIssue = "Website lead assignment could not be verified. Check the active team and assign this lead.";
  }
  // Capture the enquiry even if nobody can receive it; never use a default or
  // advance the rotation when the recipient cannot be verified.
  return { workflow, writes: [] };
}
