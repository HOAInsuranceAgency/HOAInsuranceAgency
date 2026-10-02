import { agencyDay } from "../../../../shared/leadActionGuidance";
import {
  emptyLeadSnooze,
  validateLeadSnooze,
  type LeadSnooze,
} from "../../../../shared/leadSnooze";
import type { LeadWorkflow } from "../../../../shared/leadWorkflow";
import { dataClient } from "./data";
import { absent, audit, check, commit, conflict, get, put, row } from "./store";

const changed = "This lead or follow-up changed. Refresh before saving.";

export async function readLeadSnooze(accountId: string): Promise<LeadSnooze> {
  const stored = await get<LeadSnooze>(`lead-snooze:${accountId}`);
  return stored
    ? { ...stored.data, version: stored.version }
    : emptyLeadSnooze(accountId);
}

/** A date-only list preference: it never creates tasks or scheduled deliveries. */
export async function saveLeadSnooze(
  input: Record<string, unknown>,
  actor: string,
  admin: boolean,
) {
  const accountId = input.accountId;
  if (
    typeof accountId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(accountId)
  )
    throw new Error("Choose a valid lead");
  const at = new Date().toISOString();
  const values = validateLeadSnooze(
    input.followUpOn,
    input.note,
    agencyDay(at),
  );
  const [old, workflow, deleted, account] = await Promise.all([
    get<LeadSnooze>(`lead-snooze:${accountId}`),
    get<LeadWorkflow>(`workflow:${accountId}`),
    get(`deleted-account:${accountId}`),
    (await dataClient()).models.Account.get({ id: accountId }),
  ]);
  if (!admin && (!actor || workflow?.data.salespersonId !== actor))
    throw new Error("You can only change follow-ups for your assigned leads.");
  if (!Number.isInteger(input.version) || input.version !== (old?.version ?? 0))
    throw new Error(changed);
  if (account.errors?.length || !account.data)
    throw new Error("Could not load this lead");
  if (account.data.stage !== "LEAD")
    throw new Error("Follow-ups are only available for leads.");
  if (deleted) throw new Error("This lead is being deleted.");
  const next = row<LeadSnooze>(
    "LEAD_SNOOZE",
    `lead-snooze:${accountId}`,
    {
      accountId,
      ...values,
      version: (old?.version ?? 0) + 1,
      updatedAt: at,
      updatedBy: actor,
    },
    { accountId, previous: old },
  );
  try {
    await commit([
      put(next, old),
      workflow ? check(workflow) : absent(`workflow:${accountId}`),
      absent(`deleted-account:${accountId}`),
      {
        ConditionCheck: {
          TableName: process.env.ACCOUNT_TABLE!,
          Key: { id: accountId },
          ConditionExpression: "#stage = :lead",
          ExpressionAttributeNames: { "#stage": "stage" },
          ExpressionAttributeValues: { ":lead": "LEAD" },
        },
      },
      audit(
        accountId,
        actor,
        values.followUpOn
          ? "Lead snoozed until follow-up"
          : "Lead follow-up cleared",
        values,
      ),
    ]);
  } catch (error) {
    if (conflict(error)) throw new Error(changed);
    throw error;
  }
  return next.data;
}
