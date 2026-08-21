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
 * GetItems by primary key, issued together — see `readInvoice` for why this
 * function has no data client to ask instead.
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

async function attr(
  tableName: string | undefined,
  id: string | null,
  field: string
): Promise<string | null> {
  if (!tableName || !id) return null;
  try {
    const res = await ddb.send(
      new GetCommand({ TableName: tableName, Key: { id } })
    );
    const v = res.Item?.[field];
    return typeof v === "string" && v.trim() ? v : null;
  } catch (err) {
    console.warn(`stripe-webhook could not read ${field} from ${tableName}`, err);
    return null;
  }
}

export async function readPaidContext(opts: {
  accountId: string | null;
  policyId: string | null;
}): Promise<PaidInvoiceContext> {
  const [associationName, policyNumber, carrierId] = await Promise.all([
    attr(process.env.ACCOUNT_TABLE, opts.accountId, "name"),
    attr(process.env.POLICY_TABLE, opts.policyId, "policyNumber"),
    attr(process.env.POLICY_TABLE, opts.policyId, "carrierId"),
  ]);
  // Serial only because the carrier id comes off the policy. One extra hop,
  // and only on invoices that name a policy.
  const carrierName = await attr(process.env.CARRIER_TABLE, carrierId, "name");
  return { associationName, policyNumber, carrierName };
}
