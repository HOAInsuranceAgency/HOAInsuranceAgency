import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

/**
 * Writing a payment state change, without losing a race.
 *
 * ## Why the decision alone is not enough
 *
 * The handler reads an invoice, decides from it, then writes. Ordering is
 * enforced in the decision, which means it is enforced against a snapshot: two
 * events delivered concurrently both read the same pre-state, both decide to
 * apply, and whichever finishes last wins regardless of which event is newer.
 * A stale `payment_failed` could land on top of a `succeeded` and record
 * received money as outstanding.
 *
 * So the write carries the read forward as a condition: apply only if
 * `stripeEventAt` is still exactly what the decision was made against. If
 * another invocation moved it, this one re-reads and decides again — the
 * ordinary optimistic-concurrency shape, and the same escape from Amplify's
 * data client that `uploadQuota.ts` takes for the same reason.
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());

/**
 * Everything the decision read, as it was when it read it.
 *
 * The condition below is built from all of it. Conditioning on a subset is the
 * bug this replaces: the write guarded only `stripeEventAt`, so a producer
 * pressing Void — which writes `status` and never touches the event clock —
 * slipped between the read and the write and was silently overwritten by the
 * payment state. An optimistic-concurrency check has to cover the whole read
 * set or it is not a check, it is a coincidence.
 */
export interface PaymentSnapshot {
  status: string | null;
  stripeEventAt: string | null;
  stripePaymentIntentId: string | null;
  stripeIntentCreatedAt: string | null;
}

export interface PaymentWrite {
  tableName: string;
  invoiceId: string;
  /** The row as the decision saw it. */
  seen: PaymentSnapshot;
  status: string;
  paidAt: string | null;
  paymentIntentId: string;
  occurredAt: string;
  intentCreatedAt: string | null;
}

/**
 * Apply the change, or report that the invoice moved underneath us.
 *
 * Returns true when written. False means another invocation got there first and
 * the caller should re-read; it is not an error, and it is expected under any
 * real concurrency.
 */
export async function writePaymentState(w: PaymentWrite): Promise<boolean> {
  const names: Record<string, string> = { "#eventAt": "stripeEventAt" };
  const values: Record<string, unknown> = {
    ":status": w.status,
    ":intent": w.paymentIntentId,
    ":eventAt": w.occurredAt,
    // Named, so the activity log shows the payment did this rather than a
    // person. This write bypasses the data client's actor proxy.
    ":writer": "stripe-payment",
  };

  let set = "SET #seenStatus = :status, stripePaymentIntentId = :intent, #eventAt = :eventAt, lastWriteBy = :writer";
  if (w.intentCreatedAt) {
    set += ", stripeIntentCreatedAt = :intentCreatedAt";
    values[":intentCreatedAt"] = w.intentCreatedAt;
  }
  if (w.paidAt) {
    set += ", paidAt = :paidAt";
    values[":paidAt"] = w.paidAt;
  }
  /**
   * Amplify stamps `updatedAt` itself on every write through the data client.
   * A raw update would otherwise leave it showing the moment before a payment
   * settled, which is misleading on a row whose whole purpose is money.
   */
  set += ", updatedAt = :now";
  values[":now"] = new Date().toISOString();

  /**
   * One clause per field the decision read.
   *
   * Absent and present are different clauses: a combined
   * `attribute_not_exists OR =` would also pass for a row that has since had
   * the attribute cleared, which is a change we would be ignoring.
   */
  const clauses: string[] = [];
  const guard = (alias: string, attribute: string, seen: string | null) => {
    names[alias] = attribute;
    if (seen === null) {
      clauses.push(`attribute_not_exists(${alias})`);
    } else {
      clauses.push(`${alias} = :seen_${attribute}`);
      values[`:seen_${attribute}`] = seen;
    }
  };
  guard("#eventAt", "stripeEventAt", w.seen.stripeEventAt);
  guard("#seenStatus", "status", w.seen.status);
  guard("#seenIntent", "stripePaymentIntentId", w.seen.stripePaymentIntentId);
  guard("#seenIntentAt", "stripeIntentCreatedAt", w.seen.stripeIntentCreatedAt);
  const condition = clauses.join(" AND ");

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: w.tableName,
        Key: { id: w.invoiceId },
        UpdateExpression: set,
        ConditionExpression: condition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
      return false;
    }
    throw err;
  }
}

/** The row, as much of it as the decision, the log lines and the split need. */
export interface InvoiceRow extends PaymentSnapshot {
  id: string;
  number: string | null;
  accountId: string | null;
  policyId: string | null;
  /** W8: the pre-bind anchor; a bind rollover leaves both ids set. */
  quoteId: string | null;
  /**
   * The division written by the last send. Read rather than recomputed — see
   * `remittance.ts` for why the lines are the wrong source once a Payment Link
   * has fixed the price.
   */
  remittanceCarrierCents: number | null;
  remittanceCommissionCents: number | null;
  remittanceInterestCents: number | null;
}

/**
 * Read the invoice the decision will be made against.
 *
 * Directly from DynamoDB rather than through the data client, for two reasons.
 * The function is reached at a Function URL and has no AppSync configuration at
 * all — `getAmplifyDataClientConfig` threw "data environment variables are
 * malformed" on every real delivery, because nothing in `data/resource.ts`
 * grants this function model access and nothing should have to.
 *
 * The second reason outlives the first: `ConsistentRead`. The write below is
 * conditional on the values read here, and the handler retries when the
 * condition fails. An eventually-consistent read can hand the retry the same
 * pre-state it just lost with, so the second attempt fails identically and the
 * event goes back to Stripe for no reason. Reading strongly is what lets the
 * loop actually converge.
 */
export async function readInvoice(
  tableName: string,
  invoiceId: string
): Promise<InvoiceRow | null> {
  const res = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { id: invoiceId },
      ConsistentRead: true,
    })
  );
  const item = res.Item;
  if (!item) return null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const int = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    id: String(item.id),
    number: str(item.number),
    accountId: str(item.accountId),
    policyId: str(item.policyId),
    quoteId: str(item.quoteId),
    remittanceCarrierCents: int(item.remittanceCarrierCents),
    remittanceCommissionCents: int(item.remittanceCommissionCents),
    remittanceInterestCents: int(item.remittanceInterestCents),
    status: str(item.status),
    stripeEventAt: str(item.stripeEventAt),
    stripePaymentIntentId: str(item.stripePaymentIntentId),
    stripeIntentCreatedAt: str(item.stripeIntentCreatedAt),
  };
}
