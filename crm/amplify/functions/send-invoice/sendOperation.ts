import { randomUUID } from "node:crypto";
import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Write } from "../broker-fees/store";
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
  retired?: { reason: "VOID"; invoiceId: string; retiredAt: string; closedLinkId: string | null };
};
type Dependencies = { database: Pick<DynamoDBDocumentClient, "send">; now?: () => number; uuid?: () => string; invoiceTable?: string };
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

/** Server-only proof is bound to this withdrawn invoice and the closed link.
 * It preserves uncertain delivery history without treating it as a success. */
export function isRetiredInvoiceSend(invoice: Record<string, unknown>): boolean {
  const operation = invoice.invoiceSendOperation;
  if (!valid(operation) || !operation.key.startsWith(`invoice:${invoice.id}:`) || invoice.status !== 'VOID') return false;
  const retired = operation.retired, at = Date.parse(retired?.retiredAt ?? '');
  return retired?.reason === 'VOID' && retired.invoiceId === invoice.id && Number.isFinite(at)
    && (operation.completed !== undefined || operation.leaseUntil <= at)
    && retired.closedLinkId === (invoice.stripePaymentLinkId || null);
}
export function invoiceSendSettled(invoice: Record<string, unknown>): boolean {
  const operation = invoice.invoiceSendOperation;
  return operation == null || isRetiredInvoiceSend(invoice) || valid(operation) && !operation.retired && !!operation.completed;
}
/** Void can retire the existing operation only after its worker has drained.
 * This exceeds Send's hard 60-second timeout. A current operator recovery has
 * its own mail-ledger SENDING timestamp and is fenced separately below. */
export async function prepareInvoiceSendRetirement(invoice: Record<string, unknown>, deps: Dependencies): Promise<{ operation?: InvoiceSendOperation; writes: Write[] }> {
  const previous = invoice.invoiceSendOperation;
  if (previous === undefined) return { writes: [] };
  if (!valid(previous) || !previous.key.startsWith(`invoice:${invoice.id}:`)) return blocked('The invoice delivery record needs review before it can be retired.');
  if (isRetiredInvoiceSend(invoice)) return { operation: previous, writes: [] };
  const now = (deps.now ?? Date.now)();
  if (!previous.completed && previous.leaseUntil > now) return blocked('This invoice send is still in progress. Wait two minutes, then retry Void.');
  const retiredAt = new Date(now).toISOString();
  const operation: InvoiceSendOperation = { ...previous, retired: { reason: 'VOID', invoiceId: String(invoice.id), retiredAt, closedLinkId: typeof invoice.stripePaymentLinkId === 'string' && invoice.stripePaymentLinkId ? invoice.stripePaymentLinkId : null } };
  const env = environment(), TableName = process.env.HOA_TRANSACTIONAL_MAIL_TABLE!;
  const key = `OP#hoa/${env}/invoice/${hash(previous.key)}`;
  const ledger = (await deps.database.send(new GetCommand({ TableName, Key: { pk: key }, ConsistentRead: true }))).Item;
  if (ledger?.state === 'SENDING' && (!Number.isFinite(Date.parse(ledger.updatedAt)) || Date.parse(ledger.updatedAt) + LEASE_MS > now)) return blocked('This invoice email is still in progress. Wait two minutes, then retry Void.');
  const names: Record<string,string> = {}, values: Record<string,unknown> = { ':retired':retiredAt, ':invoice':String(invoice.id), ':reason':'INVOICE_VOID' }, conditions:string[]=[];
  if (!ledger) conditions.push('attribute_not_exists(pk)');
  else for(const [index,field] of ['state','attempt','payloadHash','payloadKey','provider','providerId','updatedAt','retiredAt'].entries()) {
    const name=`#l${index}`,value=`:l${index}`;names[name]=field;
    if(Object.hasOwn(ledger,field)){conditions.push(`${name} = ${value}`);values[value]=ledger[field];}else conditions.push(`attribute_not_exists(${name})`);
  }
  // Keep ACCEPTED/UNKNOWN/REJECTED and provider evidence exactly as recorded.
  // This terminal marker also tombstones an absent OP before an old replay can
  // reserve it. The sender/recovery claim refuses retiredAt atomically.
  const write:Write={Update:{TableName,Key:{pk:key},UpdateExpression:'SET retiredAt = :retired, retiredInvoiceId = :invoice, retirementReason = :reason',ConditionExpression:conditions.join(' AND '),...(Object.keys(names).length?{ExpressionAttributeNames:names}:{}),ExpressionAttributeValues:values}};
  return { operation, writes:[write] };
}

/** Repair old VOID rows automatically inside the existing quote/publication
 * transaction. V1/V2 Void verified its sessions; an unflagged linked legacy
 * row still needs processor closure through Void before this proof is safe. */
export async function voidedInvoiceSendRetirementWrites(invoice: Record<string, unknown>, deps: Dependencies): Promise<Write[]> {
  if(invoiceSendSettled(invoice))return [];
  if(invoice.status!=='VOID'||![1,2].includes(Number(invoice.sourcePricingVersion))&&(invoice.stripePaymentLinkId||invoice.paymentUrl))return blocked('Close the existing invoice payment sessions before retiring its delivery.');
  const retirement=await prepareInvoiceSendRetirement(invoice,deps),TableName=deps.invoiceTable??process.env.INVOICE_TABLE;
  if(!TableName||!retirement.operation)return blocked('Invoice send retirement is not configured.');
  const now=new Date(Math.max((deps.now??Date.now)(),Date.parse(String(invoice.updatedAt))+1)).toISOString();
  return [{Update:{TableName,Key:{id:invoice.id},UpdateExpression:'SET #op = :retired, updatedAt = :now',ConditionExpression:'#status = :void AND updatedAt = :old AND #op = :previous',ExpressionAttributeNames:{'#op':'invoiceSendOperation','#status':'status'},ExpressionAttributeValues:{':retired':retirement.operation,':now':now,':void':'VOID',':old':invoice.updatedAt,':previous':invoice.invoiceSendOperation}}},...retirement.writes];
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
  if (previous?.retired) return blocked("This invoice send was retired when the invoice was voided.");
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
