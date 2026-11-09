import { GetCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { hash } from "../transactional-mail/contract";
import { invoiceSendEnvironment, validInvoiceSendOperation, type GroupedDeliveryProof, type InvoiceSendOperation } from "./sendOperation";

type Database = Pick<DynamoDBDocumentClient, "send">;
type Expected = { loanId?: string; token?: string; to?: string[]; previousSentAt?: string | null; providerId?: string };
const SHA256 = /^[a-f0-9]{64}$/;
const PROVIDER_ID = /^[a-zA-Z0-9_-]{8,256}$/;
const NO_PAYMENT_FIELDS = ["paymentUrl", "stripePaymentLinkId", "stripePaymentIntentId", "stripeLinkAmountCents", "paidAt", "brokerFeeAllocations", "brokerFeeFinanceUrl"] as const;
const recipientHash = (addresses: string[]) => hash(addresses.map(address => address.trim().toLowerCase()).sort().join(","));

/** Pin the exact original mail and loan before the operation can contact SES. */
export async function prepareGroupedDelivery(invoiceId: string, operation: InvoiceSendOperation, proof: GroupedDeliveryProof, database: Database) {
  const table = process.env.INVOICE_TABLE;
  if (!table || operation.previousSentAt !== null || operation.completed || operation.retired ||
      !operation.key.startsWith(`invoice:${invoiceId}:`) || !validProof(proof, operation)) throw new Error("Invalid grouped invoice delivery proof.");
  await database.send(new UpdateCommand({
    TableName: table, Key: { id: invoiceId }, UpdateExpression: "SET #op = :prepared",
    ConditionExpression: "#op = :operation AND #status = :draft AND groupedFinanceLoanId = :loan AND attribute_not_exists(sentAt)",
    ExpressionAttributeNames: { "#op": "invoiceSendOperation", "#status": "status" },
    ExpressionAttributeValues: { ":operation": operation, ":prepared": { ...operation, groupedDelivery: proof }, ":draft": "DRAFT", ":loan": proof.loanId },
  }));
}

function validProof(proof: GroupedDeliveryProof | undefined, operation: InvoiceSendOperation): proof is GroupedDeliveryProof {
  return !!proof && typeof proof.loanId === "string" && !!proof.loanId && typeof proof.tokenHash === "string" && SHA256.test(proof.tokenHash) &&
    typeof proof.payloadHash === "string" && SHA256.test(proof.payloadHash) && typeof proof.sentTo === "string" && !!proof.sentTo &&
    recipientHash(proof.sentTo.split(",")) === operation.recipients && typeof proof.subject === "string" && !!proof.subject &&
    Number.isSafeInteger(proof.carrierCents) && proof.carrierCents >= 0 && Number.isSafeInteger(proof.commissionCents);
}

/** Finish the original send from durable SES acceptance. Never replays mail or opens checkout. */
export async function reconcileAcceptedGroupedSend(invoiceId: string, expected: Expected, database: Database) {
  const invoiceTable = process.env.INVOICE_TABLE;
  const loanTable = process.env.PF_LOAN_TABLE;
  const ledgerTable = process.env.HOA_TRANSACTIONAL_MAIL_TABLE;
  if (!invoiceTable || !loanTable || !ledgerTable) return null;
  const environment = invoiceSendEnvironment();
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = (await database.send(new GetCommand({ TableName: invoiceTable, Key: { id: invoiceId }, ConsistentRead: true }))).Item;
    if (!row || row.sourcePricingVersion !== 3 || row.policyId || row.quoteId || !row.accountId ||
        !Array.isArray(row.groupedPolicyIds) || row.groupedPolicyIds.length < 2 || NO_PAYMENT_FIELDS.some(field => row[field] != null) ||
        (row.status !== "DRAFT" && row.status !== "SENT")) return null;
    const op = row.invoiceSendOperation;
    if (!validInvoiceSendOperation(op) || !op.key.startsWith(`invoice:${invoiceId}:`) || op.retired || op.previousSentAt !== null ||
        (expected.previousSentAt !== undefined && (expected.previousSentAt || null) !== op.previousSentAt) ||
        (expected.to && recipientHash(expected.to) !== op.recipients)) return null;
    const proof = op.groupedDelivery;
    if (!validProof(proof, op) || row.groupedFinanceLoanId !== proof.loanId || (expected.loanId && expected.loanId !== proof.loanId) ||
        (expected.token && hash(expected.token) !== proof.tokenHash)) return null;

    const idempotencyKey = `hoa/${environment}/invoice/${hash(op.key)}`;
    const pk = `OP#${idempotencyKey}`;
    const ledger = (await database.send(new GetCommand({ TableName: ledgerTable, Key: { pk }, ConsistentRead: true }))).Item;
    const acceptedAt = ledger?.acceptedAt;
    const providerId = ledger?.providerId;
    if (!ledger || ledger.kind !== "OPERATION" || ledger.mailKind !== "invoice" || ledger.environment !== environment ||
        ledger.idempotencyKey !== idempotencyKey || ledger.provider !== "ses" || ledger.state !== "ACCEPTED" || ledger.retiredAt != null ||
        ledger.payloadHash !== proof.payloadHash || typeof providerId !== "string" || !PROVIDER_ID.test(providerId) ||
        (expected.providerId && expected.providerId !== providerId) || typeof acceptedAt !== "string" || !Number.isFinite(Date.parse(acceptedAt))) return null;
    const result = { ok: true as const, sentTo: proof.sentTo, subject: proof.subject, sentAt: acceptedAt };
    if (row.status === "SENT") {
      return op.completed?.providerId === providerId && row.sentAt === acceptedAt && row.sentTo === proof.sentTo &&
        op.completed.result.sentAt === acceptedAt && op.completed.result.sentTo === proof.sentTo &&
        op.completed.result.subject === proof.subject ? result : null;
    }
    if (row.sentAt != null || op.completed || typeof row.updatedAt !== "string") return null;

    const loan = (await database.send(new GetCommand({ TableName: loanTable, Key: { id: proof.loanId }, ConsistentRead: true }))).Item;
    if (!loan || loan.id !== proof.loanId || loan.status !== "QUOTED" || loan.groupedInvoiceId !== invoiceId || loan.accountId !== row.accountId ||
        loan.policyId || loan.quoteId || !Array.isArray(loan.groupedPolicyIds) || JSON.stringify(loan.groupedPolicyIds) !== JSON.stringify(row.groupedPolicyIds) ||
        typeof loan.electionToken !== "string" || hash(loan.electionToken) !== proof.tokenHash ||
        typeof loan.premium !== "number" || Math.round(loan.premium * 100) !== proof.carrierCents + proof.commissionCents) return null;

    const ledgerValues = { ":kind": "OPERATION", ":mailKind": "invoice", ":env": environment, ":key": idempotencyKey,
      ":provider": "ses", ":accepted": "ACCEPTED", ":id": providerId, ":at": acceptedAt, ":hash": proof.payloadHash };
    try {
      await database.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: {
          TableName: ledgerTable, Key: { pk },
          ConditionExpression: "#kind = :kind AND mailKind = :mailKind AND environment = :env AND idempotencyKey = :key AND #provider = :provider AND #state = :accepted AND providerId = :id AND acceptedAt = :at AND payloadHash = :hash AND attribute_not_exists(retiredAt)",
          ExpressionAttributeNames: { "#kind": "kind", "#provider": "provider", "#state": "state" }, ExpressionAttributeValues: ledgerValues,
        } },
        { ConditionCheck: {
          TableName: loanTable, Key: { id: proof.loanId },
          ConditionExpression: "#status = :quoted AND groupedInvoiceId = :invoice AND accountId = :account AND groupedPolicyIds = :members AND electionToken = :token AND premium = :premium AND attribute_not_exists(policyId) AND attribute_not_exists(quoteId)",
          ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":quoted": "QUOTED", ":invoice": invoiceId,
            ":account": row.accountId, ":members": row.groupedPolicyIds, ":token": loan.electionToken, ":premium": loan.premium },
        } },
        { Update: {
          TableName: invoiceTable, Key: { id: invoiceId },
          ConditionExpression: "#op = :op AND #status = :draft AND updatedAt = :version AND groupedFinanceLoanId = :loan AND groupedPolicyIds = :members AND attribute_not_exists(sentAt)",
          UpdateExpression: "SET #op = :complete, #status = :sent, sentAt = :sentAt, sentTo = :sentTo, updatedAt = :now, lastWriteBy = :actor, remittanceCarrierCents = :carrier, remittanceCommissionCents = :commission, remittanceInterestCents = :zero, remittanceBrokerFeeCents = :zero",
          ExpressionAttributeNames: { "#op": "invoiceSendOperation", "#status": "status" },
          ExpressionAttributeValues: { ":op": op, ":draft": "DRAFT", ":version": row.updatedAt, ":loan": proof.loanId, ":members": row.groupedPolicyIds,
            ":complete": { ...op, completed: { providerId, result } }, ":sent": "SENT", ":sentAt": acceptedAt, ":sentTo": proof.sentTo,
            ":now": new Date().toISOString(), ":actor": "send-invoice", ":carrier": proof.carrierCents, ":commission": proof.commissionCents, ":zero": 0 },
        } },
      ] }));
      return result;
    } catch (error) {
      if ((error as { name?: string }).name !== "TransactionCanceledException") throw error;
      // The original sender and a customer with the link can reconcile together.
    }
  }
  return null;
}
