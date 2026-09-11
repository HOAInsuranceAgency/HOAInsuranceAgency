import { annualReturn } from "../../../../shared/renewalPolicy";
import { taskWakeAt } from "../../../../shared/leadWorkflow";
import { get, commit, put, row, check, audit, canonical, hash, issue } from "./store";
import { ensureWorkflow, expected, makeTask } from "./workflow";
import { dataClient } from "./data";
import { config } from "./config";
import { contactFence } from "./contactProgress";

/** One business decision, one versioned date change and durable return checkpoint. */
export async function nextYear(input: { accountId: string; version: number; expiration: string; requestId: string }, actor: string) {
  if (!/^[a-zA-Z0-9-]{20,100}$/.test(input.requestId)) throw new Error("Refresh before moving this lead to next year");
  const key = `annual-return:${actor}:${input.requestId}`, fingerprint = hash(canonical({ accountId: input.accountId, expiration: input.expiration }));
  const receipt = await get<{ fingerprint: string; expiration: string; returnAt: string }>(key);
  if (receipt) { if (receipt.data.fingerprint !== fingerprint) throw new Error("This request was already used for a different lead cycle"); return receipt.data; }
  const wf = await ensureWorkflow(input.accountId); expected(wf, input.version);
  if (wf.data.disposition !== "ACTIVE") throw new Error("Next year is available for active leads");
  const account = await (await dataClient()).models.Account.get({ id: input.accountId });
  if (account.errors?.length || !account.data || account.data.stage !== "LEAD") throw new Error("The current lead could not be verified");
  if (account.data.currentPolicyExpiration !== input.expiration) throw new Error("The incumbent date changed. Refresh before continuing.");
  const now = new Date().toISOString(), plan = annualReturn(input.expiration, (await config()).holidays, now);
  const task = await makeTask({ id: `task:annual:${input.accountId}:${plan.expiration}`, accountId: input.accountId, title: "Reconnect before the next renewal", kind: "ANNUAL_RETURN", dueAt: plan.returnAt, sourceAt: now, conversationId: wf.data.conversationId, domain: "CLIENT", context: "LEAD", term: plan.expiration });
  const existingTask = await get(task.id), fence = await contactFence(input.accountId);
  if (!process.env.ACCOUNT_TABLE) throw new Error("Account updates are not configured");
  await commit([
    { Update: { TableName: process.env.ACCOUNT_TABLE, Key: { id: input.accountId }, UpdateExpression: "SET currentPolicyExpiration = :next, updatedAt = :now, lastWriteBy = :actor", ConditionExpression: "currentPolicyExpiration = :before AND updatedAt = :version AND #stage = :lead", ExpressionAttributeNames: { "#stage": "stage" }, ExpressionAttributeValues: { ":next": plan.expiration, ":now": now, ":actor": actor, ":before": input.expiration, ":version": account.data.updatedAt, ":lead": "LEAD" } } },
    put(row("WORKFLOW", wf.id, { ...wf.data, deferredUntil: plan.returnAt, deferredExpiration: plan.expiration, deferredAt: now, humanTakeover: true, version: wf.version + 1 }, { accountId: input.accountId, previous: wf }), wf),
    check(fence), put(row("TASK", task.id, task, { accountId: input.accountId, dueAt: taskWakeAt(task), previous: existingTask }), existingTask),
    put(row("ANNUAL_RETURN", key, { fingerprint, ...plan }, { accountId: input.accountId })),
    put(row("LIFECYCLE", `lifecycle:annual:${input.accountId}:${wf.version}`, { accountId: input.accountId }, { accountId: input.accountId, dueAt: now })),
    audit(input.accountId, actor, "Lead moved to next year", { previousIncumbentExpiration: input.expiration, incumbentExpiration: plan.expiration, returns: plan.returnAt }),
  ]);
  if (plan.stale) await issue(`annual-date:${input.accountId}`, "The advanced incumbent date is still in the past. Outreach resumes next morning; confirm the actual renewal date.", input.accountId);
  return plan;
}
