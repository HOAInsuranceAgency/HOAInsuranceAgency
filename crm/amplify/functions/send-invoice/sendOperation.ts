import { randomUUID } from "node:crypto";
import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { hash, MailDeliveryError } from "../transactional-mail/contract";

// Private DynamoDB attribute: deliberately absent from the public model, so a
// browser cannot clear an uncertain send or manufacture a completed operation.
const ATTRIBUTE = "invoiceSendOperation";
// send-invoice has a 60-second Lambda timeout. A retry cannot take the operation
// while the prior invocation can still be creating links or contacting mail.
const LEASE_MS = 120_000;
export const INVOICE_SEND_GENERATION = "invoice-send-v1-2026-11-02";
type Invoice = { id: string; updatedAt?: string | null; sentAt?: string | null; status?: string | null };
type Result = { ok: true; sentTo: string; subject: string; sentAt: string };
export type InvoiceSendOperation = {
  version: 1; key: string; recipients: string; previousSentAt: string | null;
  leaseId: string; leaseUntil: number;
  completed?: { providerId: string; result: Result };
};
type Dependencies = { database: Pick<DynamoDBDocumentClient, "send">; now?: () => number; uuid?: () => string };
export class InvoiceSendBlocked extends Error {}
const blocked = (message: string): never => { throw new InvoiceSendBlocked(message); };
function environment() {
  if (process.env.HOA_MIGRATION_APP_ID !== "d1nuh9rw1hcuxo"
    || process.env.HOA_TRANSACTIONAL_MAIL_TABLE !== "HOA-TransactionalMail"
    || !["codex-hoa-account-migration", "codex-hoa-staging-migration"].includes(process.env.HOA_MIGRATION_BRANCH ?? "")) {
    return blocked("Invoice email is not bound to the destination delivery ledger.");
  }
  return process.env.HOA_MIGRATION_BRANCH === "codex-hoa-account-migration" ? "main" : "staging";
}
function valid(value: any): value is InvoiceSendOperation {
  return value?.version === 1 && typeof value.key === "string" && value.key.startsWith("invoice:")
    && /^[a-f0-9]{64}$/.test(value.recipients) && (value.previousSentAt === null || typeof value.previousSentAt === "string")
    && typeof value.leaseId === "string" && Number.isFinite(value.leaseUntil)
    && (!value.completed || (typeof value.completed.providerId === "string" && value.completed.result?.ok === true
      && typeof value.completed.result.sentAt === "string" && typeof value.completed.result.sentTo === "string" && typeof value.completed.result.subject === "string"));
}

/** Root-only, post-deployment zero-legacy inventory; never created by this handler. */
export function validLegacyAdoptionProof(proof: any, env: string, now: number) {
  const observed = Date.parse(proof?.observedAt ?? "");
  const verified = Date.parse(proof?.deploymentVerifiedAt ?? "");
  const started = Date.parse(proof?.scanStartedAt ?? "");
  return proof?.status === "ROOT_REVIEWED_ZERO_LEGACY_INVOICE_OPERATIONS"
    && proof.schema === 1 && proof.generation === INVOICE_SEND_GENERATION
    && proof.account === "917680434255" && proof.app === "d1nuh9rw1hcuxo"
    && proof.environment === env && proof.runtimeBranch === process.env.HOA_MIGRATION_BRANCH
    && proof.functionName === process.env.AWS_LAMBDA_FUNCTION_NAME
    && typeof proof.functionName === "string" && proof.functionName.startsWith("amplify-d1nuh9rw1hcuxo-")
    && typeof proof.deployedCodeSha256 === "string" && /^[A-Za-z0-9+/]{43}=$/.test(proof.deployedCodeSha256)
    && /^[a-f0-9]{64}$/.test(proof.inventorySha256 ?? "")
    && proof.invoiceOperationCount === 0 && proof.consistentRead === true && proof.completePagination === true
    && Number.isFinite(verified) && started >= verified + 60_000
    && observed >= started && observed <= now;
}

/** Reserve before any link/finance side effect. updatedAt is never a retry ID. */
export async function beginInvoiceSend(invoice: Invoice, to: string[], expectedSentAt: string | null | undefined, deps: Dependencies): Promise<{ operation: InvoiceSendOperation; completed?: Result }> {
  const env = environment();
  const table = process.env.INVOICE_TABLE;
  if (!table) return blocked("The invoice send reservation is unavailable. No email was sent.");
  const db = deps.database; const now = (deps.now ?? Date.now)(); const uuid = deps.uuid ?? randomUUID;
  const row = (await db.send(new GetCommand({ TableName: table, Key: { id: invoice.id }, ConsistentRead: true }))).Item;
  if (!row || row.updatedAt !== invoice.updatedAt || row.status !== invoice.status || row.status === "VOID") return blocked("The invoice changed. Refresh it before sending.");
  const previous = row[ATTRIBUTE] as InvoiceSendOperation | undefined;
  if (previous !== undefined && (!valid(previous) || !previous.key.startsWith(`invoice:${invoice.id}:`))) return blocked("The invoice delivery record needs review. No replacement was sent.");
  const recipients = hash(to.map(address => address.trim().toLowerCase()).sort().join(","));
  const observedSentAt = expectedSentAt === undefined ? undefined : expectedSentAt || null;
  let replacement = false;
  if (previous) {
    // A fresh, explicit Send after a confirmed send can create another operation.
    // Repeating the old request after a lost response carries the old sentAt and
    // therefore reuses the prior operation. An edit never rotates an UNKNOWN.
    replacement = Boolean(previous.completed && observedSentAt === previous.completed.result.sentAt
      && observedSentAt !== previous.previousSentAt && row.sentAt === observedSentAt);
    if (!replacement && observedSentAt !== undefined && observedSentAt !== previous.previousSentAt) return blocked("The invoice delivery record changed. Refresh it before sending.");
    if (!replacement && previous.recipients !== recipients) return blocked("This invoice has a send reserved for other recipients. Review that delivery before sending a replacement.");
  } else if (observedSentAt !== undefined && observedSentAt !== (row.sentAt ?? null)) {
    return blocked("The invoice send details changed. Refresh it before sending.");
  }
  const key = previous && !replacement ? previous.key : previous
    ? `invoice:${invoice.id}:send:${uuid()}`
    // Keep the deployed key for first adoption, including its original recipient
    // spelling/order. Existing records at that key must retain their decisions.
    : `invoice:${invoice.id}:${invoice.updatedAt ?? invoice.sentAt ?? "initial"}:${to.join(",")}`;
  const oldKey = previous?.key ?? key;
  const ledgerKey = `OP#hoa/${env}/invoice/${hash(oldKey)}`;
  const delivery = (await db.send(new GetCommand({ TableName: process.env.HOA_TRANSACTIONAL_MAIL_TABLE!, Key: { pk: ledgerKey }, ConsistentRead: true }))).Item;
  if (previous?.completed) {
    if (delivery?.state !== "ACCEPTED" || delivery.providerId !== previous.completed.providerId) return blocked("The confirmed invoice delivery no longer matches its ledger. Review it before sending.");
    if (!replacement) return { operation: previous, completed: previous.completed.result };
  } else if (delivery) {
    if (delivery.state === "ACCEPTED") return blocked("This invoice email was accepted, but its send details need review. No replacement was sent.");
    if (["DEFERRED", "RESERVED"].includes(delivery.state)) return blocked("This invoice's saved email needs operator delivery review. This button will not create a replacement or retry its saved payload.");
    throw new MailDeliveryError(["DEFERRED", "REJECTED", "SUPPRESSED"].includes(delivery.state) ? delivery.state : "UNKNOWN", ledgerKey);
  }
  if (!previous) {
    // Old storeLink/recordSend writes changed the timestamp before a stable ID
    // existed. Absence of the current-derived key cannot clear an older hold.
    const proof = (await db.send(new GetCommand({ TableName: process.env.HOA_TRANSACTIONAL_MAIL_TABLE!,
      Key: { pk: `CONTROL#hoa/${env}/${INVOICE_SEND_GENERATION}/legacy-zero` }, ConsistentRead: true }))).Item;
    // The complete zero-OP scan happens after the old version drains, while the
    // new version refuses untracked sends without this proof. Later edits do not
    // invalidate that global fact, and ordinary model updates preserve #op.
    if (!validLegacyAdoptionProof(proof, env, now)) return blocked("This invoice needs its prior-delivery review before sending. No payment link or email was created.");
  }
  if (previous && !replacement && previous.leaseUntil > now) return blocked("This invoice send is still in progress. Wait two minutes before checking it again.");
  const operation: InvoiceSendOperation = { version: 1, key, recipients, previousSentAt: replacement ? row.sentAt : previous?.previousSentAt ?? row.sentAt ?? null, leaseId: uuid(), leaseUntil: now + LEASE_MS };
  try {
    await db.send(new UpdateCommand({ TableName: table, Key: { id: invoice.id },
      UpdateExpression: "SET #op = :op",
      ConditionExpression: `attribute_exists(id) AND #status = :status AND ${row.updatedAt === undefined ? "attribute_not_exists(updatedAt)" : "updatedAt = :updated"} AND ${previous ? "#op = :previous" : "attribute_not_exists(#op)"}`,
      ExpressionAttributeNames: { "#op": ATTRIBUTE, "#status": "status" },
      ExpressionAttributeValues: { ":op": operation, ":status": row.status, ...(row.updatedAt === undefined ? {} : { ":updated": row.updatedAt }), ...(previous ? { ":previous": previous } : {}) },
    }));
  } catch (error) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") return blocked("Another send or edit won this invoice. Refresh it before trying again.");
    // An uncertain reservation is not permission to reach Stripe or the sender.
    throw error;
  }
  return { operation };
}

/** Only an accepted provider response AND persisted send facts can unlock resend. */
export async function completeInvoiceSend(invoiceId: string, operation: InvoiceSendOperation, providerId: string | undefined, result: Result, deps: Dependencies) {
  if (!providerId) return blocked("The invoice delivery needs review before another send.");
  await deps.database.send(new UpdateCommand({ TableName: process.env.INVOICE_TABLE!, Key: { id: invoiceId },
    UpdateExpression: "SET #op = :completed", ConditionExpression: "#op = :previous AND sentAt = :sentAt",
    ExpressionAttributeNames: { "#op": ATTRIBUTE },
    ExpressionAttributeValues: { ":previous": operation, ":completed": { ...operation, completed: { providerId, result } }, ":sentAt": result.sentAt },
  }));
}
