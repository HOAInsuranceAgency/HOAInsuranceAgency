import { createHash, randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";

export const db = DynamoDBDocumentClient.from(new DynamoDBClient(), { marshallOptions: { removeUndefinedValues: true } });
export const table = () => { if (!process.env.COMMUNICATION_TABLE) throw new Error("Communication storage is not configured"); return process.env.COMMUNICATION_TABLE; };
export type Row<T = Record<string, unknown>> = { id: string; kind: string; version: number; data: T; createdAt: string; updatedAt: string; accountId?: string; accountSort?: string; workKind?: string; workAt?: string; dueGroup?: string; dueAt?: string };
export type Write = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function row<T>(kind: string, id: string, data: T, opts: { accountId?: string; dueAt?: string; previous?: Row<unknown> } = {}): Row<T> {
  const now = new Date().toISOString();
  const values = data as { status?: string; state?: string; resolved?: boolean; processedAt?: string; disposition?: string; salespersonId?: string; championId?: string; assignmentIssue?: string; dueAt?: string; at?: string };
  const actionable = kind === "TASK" ? values.status === "OPEN"
    : kind === "WORKFLOW" ? values.disposition === "ACTIVE" && (!values.salespersonId || !values.championId || !!values.assignmentIssue)
    : kind === "OPERATION" ? !["CONFIRMED", "SUPPRESSED"].includes(values.state ?? "")
    : kind === "REPORT_EDITION" ? values.state !== "SENT"
    : kind === "EVENT" ? !values.processedAt && !values.resolved
    : ["ISSUE", "TRIAGE", "NOTIFICATION"].includes(kind) && !values.resolved;
  return { id, kind, data, ...(actionable ? { workKind: kind, workAt: values.dueAt ?? values.at ?? opts.previous?.createdAt ?? now } : {}), version: (opts.previous?.version ?? 0) + 1, createdAt: opts.previous?.createdAt ?? now, updatedAt: now,
    ...(opts.accountId ? { accountId: opts.accountId, accountSort: opts.previous?.accountSort ?? `${kind}#${(data as { at?: string }).at ?? now}#${id}` } : {}),
    ...(opts.dueAt ? { dueGroup: "DUE", dueAt: opts.dueAt } : {}) };
}
export async function get<T = Record<string, unknown>>(id: string): Promise<Row<T> | undefined> {
  return (await db.send(new GetCommand({ TableName: table(), Key: { id }, ConsistentRead: true }))).Item as Row<T> | undefined;
}
export function put(record: Row<unknown>, previous?: Row<unknown>): Write {
  return { Put: { TableName: table(), Item: record, ConditionExpression: previous ? "#v = :v" : "attribute_not_exists(id)",
    ...(previous ? { ExpressionAttributeNames: { "#v": "version" }, ExpressionAttributeValues: { ":v": previous.version } } : {}) } };
}
export function check(record: Row<unknown>): Write {
  return { ConditionCheck: { TableName: table(), Key: { id: record.id }, ConditionExpression: "#v = :v", ExpressionAttributeNames: { "#v": "version" }, ExpressionAttributeValues: { ":v": record.version } } };
}
export async function commit(writes: Write[]) {
  if (writes.length > 100) throw new Error("Too many changes in one operation");
  if (writes.length) await db.send(new TransactWriteCommand({ TransactItems: writes }));
}
export async function save<T>(next: Row<T>, previous?: Row<unknown>) { await commit([put(next, previous)]); return next; }
export async function query<T = Record<string, unknown>>(index: "kind" | "account" | "due" | "work", key: string, nextToken?: string, limit = 100, prefix?: string) {
  const attr = index === "kind" ? "kind" : index === "work" ? "workKind" : index === "account" ? "accountId" : "dueGroup";
  let cursor: Record<string, unknown> | undefined;
  if (nextToken) { try { cursor = JSON.parse(Buffer.from(nextToken, "base64url").toString()); } catch { throw new Error("Invalid page token"); } }
  const out = await db.send(new QueryCommand({ TableName: table(), IndexName: index, KeyConditionExpression: `#k = :k${index === "due" ? " AND dueAt <= :now" : ""}${index === "account" && prefix ? " AND begins_with(accountSort, :prefix)" : ""}`,
    ExpressionAttributeNames: { "#k": attr }, ExpressionAttributeValues: { ":k": key, ...(index === "due" ? { ":now": new Date().toISOString() } : {}), ...(index === "account" && prefix ? { ":prefix": prefix } : {}) },
    ExclusiveStartKey: cursor, Limit: Math.min(limit, 100), ScanIndexForward: index !== "account" }));
  return { items: (out.Items ?? []) as Row<T>[], nextToken: out.LastEvaluatedKey ? Buffer.from(JSON.stringify(out.LastEvaluatedKey)).toString("base64url") : undefined };
}
export function audit(accountId: string, actor: string, action: string, details: unknown): Write {
  if (!process.env.ACTIVITY_TABLE) throw new Error("Account activity storage needs configuration");
  const id = `communication:${randomUUID()}`, at = new Date().toISOString();
  return { Put: { TableName: process.env.ACTIVITY_TABLE, ConditionExpression: "attribute_not_exists(id)", Item: {
    id, __typename: "Activity", entityId: accountId, subjectType: "Lead communication", subjectId: accountId,
    action: "UPDATE", actor, actorName: actor, summary: action, changes: JSON.stringify(Object.entries(details && typeof details === "object" ? details : { details }).map(([field, value]) => ({ field, from: null, to: value && typeof value === "object" ? JSON.stringify(value) : value }))),
    occurredAt: at, createdAt: at, updatedAt: at,
  } } };
}
export async function issue(id: string, message: string, accountId?: string) {
  const key = `issue:${id}`, old = await get(key);
  if (old?.data.message === message && !old.data.resolved) return;
  await save(row("ISSUE", key, { sourceId: id, message, at: new Date().toISOString(), resolved: false }, { accountId, previous: old }), old);
}
/** Only failed conditions mean another writer won. Capacity/transaction failures must retry. */
export function conflict(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === "ConditionalCheckFailedException") return true;
  if (e.name !== "TransactionCanceledException") return false;
  const reasons = (e as Error & { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
  return !!reasons?.some(r => r.Code === "ConditionalCheckFailed") && reasons.every(r => r.Code === "None" || r.Code === "ConditionalCheckFailed");
}
/** Retry transient AWS failures without confusing them with deduplication. */
export function retryableStorage(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const error = e as Error & { CancellationReasons?: { Code?: string }[]; $retryable?: unknown; $metadata?: { httpStatusCode?: number } };
  if (error.$retryable || (error.$metadata?.httpStatusCode ?? 0) >= 500) return true;
  if (["ProvisionedThroughputExceededException", "ThrottlingException", "ThrottlingError", "RequestLimitExceeded", "TransactionConflictException", "InternalServerError", "ServiceUnavailable", "TimeoutError"].includes(error.name)) return true;
  if (error.name !== "TransactionCanceledException") return false;
  return !error.CancellationReasons?.length || error.CancellationReasons.some(r => ["TransactionConflict", "ThrottlingError", "ProvisionedThroughputExceeded"].includes(r.Code ?? ""));
}
