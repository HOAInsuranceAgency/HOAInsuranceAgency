import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

/**
 * The names behind the ids on a paid invoice.
 *
 * The remittance email is read by people who have never opened the CRM, so an
 * account id is no use to them: they are reconciling a bank deposit and need
 * the association it came from and, to remit the carrier's share, the carrier
 * it is owed to.
 *
 * Read straight from the tables, like everything else in this function. Three
 * GetItems by primary key: account and policy together, then the policy's
 * carrier. See `readInvoice` for why this function has no data client.
 *
 * Every lookup fails soft. A missing name costs a line of detail in an email;
 * a throw here would happen *after* the payment state was written, so the
 * webhook would return 500 and Stripe would redeliver an event that has already
 * been applied. Losing the association's name is a nuisance; a retry storm over
 * a cosmetic read is not.
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());

export interface PaidInvoiceContext {
  associationName: string | null;
  policyNumber: string | null;
  carrierName: string | null;
}

async function readRecord(
  tableName: string | undefined,
  id: string | null
): Promise<Record<string, unknown> | null> {
  if (!tableName || !id) return null;
  try {
    const res = await ddb.send(
      new GetCommand({ TableName: tableName, Key: { id } })
    );
    return res.Item ?? null;
  } catch (err) {
    console.warn(`stripe-webhook could not read from ${tableName}`, err);
    return null;
  }
}

function attr(record: Record<string, unknown> | null, field: string): string | null {
  const value = record?.[field];
  return typeof value === "string" && value.trim() ? value : null;
}

export async function readPaidContext(opts: {
  accountId: string | null;
  policyId: string | null;
}): Promise<PaidInvoiceContext> {
  const [account, policy] = await Promise.all([
    readRecord(process.env.ACCOUNT_TABLE, opts.accountId),
    readRecord(process.env.POLICY_TABLE, opts.policyId),
  ]);
  // Serial only because the carrier id comes off the policy. One extra hop,
  // and only on invoices that name a policy.
  const carrier = await readRecord(process.env.CARRIER_TABLE, attr(policy, "carrierId"));
  return { associationName: attr(account, "name"), policyNumber: attr(policy, "policyNumber"), carrierName: attr(carrier, "name") };
}
