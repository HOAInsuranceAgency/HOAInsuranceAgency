import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { partialInput, portalUrl, submissionStatus, type SourceEstimate, type SubmissionRecord } from "./submission-contract";
const db = DynamoDBDocumentClient.from(new DynamoDBClient(), { marshallOptions: { removeUndefinedValues: true } });
const table = () => process.env.HONEYCOMB_SUBMISSION_TABLE!;
const validId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
export const submissionKey = (accountId: string, effectiveDate: string) => createHash("sha256").update(`${accountId}:${effectiveDate}`).digest("hex");
async function get<T>(TableName: string, id: string): Promise<T | undefined> {
  return (await db.send(new GetCommand({ TableName, Key: { id }, ConsistentRead: true }))).Item as T | undefined;
}
function conditional(error: unknown) { return error instanceof Error && ["ConditionalCheckFailedException", "TransactionCanceledException"].includes(error.name); }
function receipt(record: SubmissionRecord) { return { ok: true, id: record.id, status: submissionStatus(record) }; }
type Event = { info?: { fieldName?: string }; identity?: { sub?: string }; arguments: { accountId?: string; sourceEstimateId?: string | null; details?: unknown; reviewed?: boolean; retryVersion?: string | null; id?: string; outcome?: string; submissionId?: string; note?: string } };
export async function handler(event: Event) {
  const actor = event.identity?.sub;
  if (!actor) return { ok: false, error: "Sign in to manage carrier submissions." };
  if (event.info?.fieldName === "honeycombSubmissionSettings") return { enabled: process.env.HONEYCOMB_ENABLED === "true", environment: "staging" };
  if (process.env.HONEYCOMB_ENABLED !== "true") return { ok: false, error: "Honeycomb submissions are enabled in staging only." };
  try {
    if (event.info?.fieldName === "resolveHoneycombSubmission") return await resolve(event.arguments, actor);
    return await start(event.arguments, actor);
  } catch (error) {
    if (error instanceof InputError) return { ok: false, error: error.message };
    console.error("Honeycomb submission operation failed", { type: error instanceof Error ? error.name : "Error" });
    return { ok: false, error: "Could not confirm this operation. Refresh the submissions list before trying again." };
  }
}
class InputError extends Error {}
async function start(args: Event["arguments"], actor: string) {
  if (!validId(args.accountId) || args.reviewed !== true) throw new InputError("Review the property details before creating a submission.");
  const account = await get<{ id: string; type: string }>(process.env.HONEYCOMB_ACCOUNT_TABLE!, args.accountId);
  if (!account || account.type !== "ASSOCIATION") throw new InputError("Select an existing association Lead or Client.");
  let source: SourceEstimate | undefined;
  if (args.sourceEstimateId) {
    if (!validId(args.sourceEstimateId)) throw new InputError("Select a saved estimate for this account.");
    source = await get<SourceEstimate>(process.env.HONEYCOMB_ESTIMATE_TABLE!, args.sourceEstimateId);
    if (!source || source.accountId !== args.accountId) throw new InputError("The selected estimate does not belong to this account.");
  }
  let input;
  try { input = partialInput(args.details, source); } catch (error) { throw new InputError((error as Error).message); }
  const effectiveDate = input.submissionData.effectiveDate as string;
  const id = submissionKey(args.accountId, effectiveDate);
  const old = await get<SubmissionRecord>(table(), id);
  // Every repeated click, refresh or transport retry resolves to the same account/term.
  if (old && (old.status !== "REJECTED" || args.retryVersion !== old.updatedAt)) return receipt(old);
  if (old && old.attempt >= 5) throw new InputError("This request has reached five attempts. Review it with Honeycomb before proceeding.");
  const at = new Date().toISOString();
  const history = old ? [...JSON.parse(old.history ?? "[]"), { attempt: old.attempt, input: old.input, result: old.result, issue: old.issue, requestedAt: old.requestedAt, requestedBy: old.requestedBy, resolvedBy: old.resolvedBy, resolutionNote: old.resolutionNote }] : [];
  const record: SubmissionRecord & { __typename: string } = {
    __typename: "HoneycombSubmission", id, accountId: args.accountId, effectiveDate,
    status: "PENDING", attempt: (old?.attempt ?? 0) + 1, input: JSON.stringify(input),
    ...(source ? { sourceEstimateId: source.id, estimationId: source.estimationId! } : {}),
    requestedBy: actor, requestedAt: at, createdAt: old?.createdAt ?? at, updatedAt: at, history: JSON.stringify(history),
  };
  try {
    await db.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: { TableName: process.env.HONEYCOMB_ACCOUNT_TABLE!, Key: { id: account.id }, ConditionExpression: "attribute_exists(id) AND #type = :type", ExpressionAttributeNames: { "#type": "type" }, ExpressionAttributeValues: { ":type": "ASSOCIATION" } } },
      { Put: { TableName: table(), Item: record, ConditionExpression: old ? "updatedAt = :version AND #status = :rejected" : "attribute_not_exists(id)",
        ...(old ? { ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":version": old.updatedAt, ":rejected": "REJECTED" } } : {}) } },
    ] }));
  } catch (error) {
    if (conditional(error)) { const existing = await get<SubmissionRecord>(table(), id); if (existing) return receipt(existing); }
    throw error;
  }
  return receipt(record);
}
async function resolve(args: Event["arguments"], actor: string) {
  if (!validId(args.id) || args.reviewed !== true || !args.note?.trim() || args.note.length > 2000) throw new InputError("Confirm your portal review and enter a review note.");
  const old = await get<SubmissionRecord>(table(), args.id);
  if (!old) throw new InputError("Submission not found.");
  if (submissionStatus(old) !== "UNKNOWN") return receipt(old);
  if (!["LINK_EXISTING", "NOT_CREATED"].includes(args.outcome ?? "")) throw new InputError("Choose a review outcome.");
  const link = args.submissionId ? portalUrl(args.submissionId.trim()) : undefined;
  if (args.outcome === "LINK_EXISTING" && !link) throw new InputError("Enter the submission ID from the Honeycomb portal URL.");
  const record: SubmissionRecord = { ...old, updatedAt: new Date().toISOString(), resolvedBy: actor, resolutionNote: args.note.trim(),
    ...(args.outcome === "LINK_EXISTING" ? { status: "EXISTING", submissionId: args.submissionId!.trim(), portalUrl: link, submissionStatus: "linked after review", issue: "MANUALLY_LINKED" }
      : { status: "REJECTED", issue: "CONFIRMED_NOT_CREATED" }),
  };
  try {
    await db.send(new PutCommand({ TableName: table(), Item: record, ConditionExpression: "updatedAt = :version AND #status = :status", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":version": old.updatedAt, ":status": old.status } }));
  } catch (error) { if (conditional(error)) throw new InputError("The result changed while you reviewed it. Refresh and check the latest status."); throw error; }
  return receipt(record);
}
