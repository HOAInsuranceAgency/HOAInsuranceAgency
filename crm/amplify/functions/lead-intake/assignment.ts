import type { LeadWorkflow } from "../../../../shared/leadWorkflow";
import { absent, check, commit, conflict, get, issue, put, row, save, type Row, type Write } from "../communications/store";
import { indexedProducerPage, PRODUCER_INDEX_MIGRATION_ID } from "../communications/producerIndex";
import { enabledUser, UnavailableTeammateError } from "../communications/workflow";

const ROTATION_ID = "rotation:web-leads";
export interface WebLeadAssignment {
  accountId: string;
  state: "READY" | "COMPLETE" | "SUPPRESSED";
  attempts: number;
  rotationVersion?: number;
  wrapped?: boolean;
  nextToken?: string;
  error?: string;
}
export function pendingWebLeadWorkflow(accountId: string, name: string): LeadWorkflow {
  return { accountId, name, ownershipModel: "SALESPERSON", disposition: "ACTIVE", version: 1,
    updatedAt: new Date().toISOString(), assignmentIssue: "Website lead assignment is pending." };
}
/** Capture this job in the same transaction as the enquiry and delivery work. */
export function webLeadAssignmentRow(accountId: string) {
  return row<WebLeadAssignment>("WEB_LEAD_ASSIGNMENT", `web-assignment:${accountId}`, { accountId, state: "READY", attempts: 0 }, { accountId, dueAt: new Date().toISOString() });
}
async function resolvedIssue(job: Row<WebLeadAssignment>): Promise<Write[]> {
  const previous = await get(`issue:${job.id}`);
  return previous && !previous.data.resolved ? [put(row("ISSUE", previous.id,
    { ...previous.data, resolved: true, resolvedAt: new Date().toISOString(), resolution: "Website assignment completed" },
    { accountId: job.data.accountId, previous }), previous)] : [];
}
async function complete(job: Row<WebLeadAssignment>, workflow: Row<LeadWorkflow> | undefined, state: "COMPLETE" | "SUPPRESSED") {
  await commit([put(row("WEB_LEAD_ASSIGNMENT", job.id, { accountId: job.data.accountId, state, attempts: job.data.attempts }, { accountId: job.data.accountId, previous: job }), job),
    ...(workflow ? [check(workflow)] : []), ...await resolvedIssue(job)]);
}
async function defer(job: Row<WebLeadAssignment>, patch: Partial<WebLeadAssignment>, delayMs: number) {
  return save(row("WEB_LEAD_ASSIGNMENT", job.id, { ...job.data, ...patch, state: "READY" as const },
    { accountId: job.data.accountId, previous: job, dueAt: new Date(Date.now() + delayMs).toISOString() }), job);
}

/** One bounded producer page per turn. Retry state survives Lambda invocations. */
export async function runWebLeadAssignment(candidate: Row<WebLeadAssignment>) {
  let job = await get<WebLeadAssignment>(candidate.id);
  if (!job?.dueAt || job.data.state !== "READY") return;
  try {
    const accountId = job.data.accountId;
    const [workflow, deleted] = await Promise.all([get<LeadWorkflow>(`workflow:${accountId}`), get(`deleted-account:${accountId}`)]);
    if (deleted) { await complete(job, workflow, "SUPPRESSED"); return; }
    if (!workflow) throw new Error("The website lead's saved assignment record is unavailable; assignment will retry.");
    // A teammate may assign the lead while this job waits. Preserve that
    // decision and consume no turn from the automatic rotation.
    if (workflow.data.salespersonId) { await complete(job, workflow, "COMPLETE"); return; }
    const [migration, cursor] = await Promise.all([get<{ complete?: boolean }>(PRODUCER_INDEX_MIGRATION_ID), get<{ lastUserId: string }>(ROTATION_ID)]);
    if (!migration?.data.complete) throw new Error("The producer directory is being prepared. This lead will be assigned automatically when it is ready.");
    const rotationVersion = cursor?.version ?? 0, lastUserId = cursor?.data.lastUserId;
    const progress = job.data.rotationVersion === rotationVersion ? job.data : undefined;
    const wrapped = !!lastUserId && !!progress?.wrapped;
    const page = await indexedProducerPage({ ...(wrapped ? { through: lastUserId } : { after: lastUserId }), nextToken: progress?.nextToken });
    for (const member of page.items) {
      try { await enabledUser(member.data.userId); }
      catch (error) { if (error instanceof UnavailableTeammateError) continue; throw error; }
      const assigned = row("WORKFLOW", workflow.id, { ...workflow.data, salespersonId: member.data.userId, assignmentIssue: undefined,
        version: workflow.version + 1, updatedAt: new Date().toISOString() }, { accountId, previous: workflow });
      await commit([
        put(row("CURSOR", ROTATION_ID, { lastUserId: member.data.userId }, { previous: cursor }), cursor),
        put(assigned, workflow), check(member), absent(`deleted-account:${accountId}`),
        put(row("WEB_LEAD_ASSIGNMENT", job.id, { accountId, state: "COMPLETE", attempts: job.data.attempts }, { accountId, previous: job }), job),
        ...await resolvedIssue(job),
      ]);
      return;
    }
    if (page.nextToken || lastUserId && !wrapped) {
      // Keep progressing past disabled/deleted index entries. If another lead
      // advances the rotation, start from that new cursor on the next turn.
      await defer(job, { rotationVersion, wrapped: page.nextToken ? wrapped : true, nextToken: page.nextToken }, 0);
      return;
    }
    // Empty indexes can be briefly stale after eligibility changes. Leave
    // durable work queued, including when there really are no active users.
    job = await defer(job, { rotationVersion: undefined, wrapped: undefined, nextToken: undefined,
      attempts: job.data.attempts + 1, error: "No active producer is available yet. Website assignment will retry automatically; check salesperson eligibility in Team settings." }, 30_000);
    await issue(job.id, job.data.error!, accountId);
  } catch (error) {
    const current = await get<WebLeadAssignment>(job.id);
    if (!current?.dueAt || current.data.state !== "READY" || current.version !== job.version) return;
    const attempts = current.data.attempts + 1;
    const message = conflict(error) ? "Another assignment changed during this turn. Website assignment will retry automatically."
      : "Website assignment is temporarily unavailable and will retry automatically. Check the producer directory if this continues.";
    // Every conflict backs off with jitter. There is no attempt cutoff: a
    // captured enquiry cannot lose its assignment job during an outage.
    const delayMs = Math.min(300_000, (conflict(error) ? 100 : 1_000) * 2 ** Math.min(attempts - 1, 8)) + Math.floor(Math.random() * 1_000);
    await defer(current, { attempts, error: message }, delayMs);
    await issue(current.id, message, current.data.accountId);
    console.error("Website lead assignment will retry", error instanceof Error ? error.name : "unknown");
  }
}
