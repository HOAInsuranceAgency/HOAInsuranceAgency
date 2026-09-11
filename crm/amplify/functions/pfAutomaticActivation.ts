import { UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export interface ElectedLoan {
  id: string;
  status?: string | null;
  electedAt?: string | null;
  agreementSignedAt?: string | null;
  downPaidAt?: string | null;
  downPaymentIntentId?: string | null;
  stripeCustomerId?: string | null;
  stripePaymentMethodId?: string | null;
}

/** Automatically pick up settled elections left ACCEPTED by the previous release. */
export async function activateSettledElection(ddb: DynamoDBDocumentClient, table: string, loan: ElectedLoan) {
  if (loan.status !== "ACCEPTED" || !loan.electedAt || !loan.agreementSignedAt || !loan.downPaidAt ||
      !loan.downPaymentIntentId || !loan.stripeCustomerId || !loan.stripePaymentMethodId) return false;
  const now = new Date().toISOString();
  try {
    await ddb.send(new UpdateCommand({
      TableName: table,
      Key: { id: loan.id },
      UpdateExpression: "SET #s = :active, activatedAt = if_not_exists(activatedAt, :now), updatedAt = :now",
      ConditionExpression: "#s = :accepted AND downPaymentIntentId = :pi AND stripeCustomerId = :cus AND stripePaymentMethodId = :pm AND attribute_exists(downPaidAt) AND attribute_exists(agreementSignedAt) AND attribute_exists(electedAt)",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":active": "ACTIVE", ":accepted": "ACCEPTED", ":now": now,
        ":pi": loan.downPaymentIntentId, ":cus": loan.stripeCustomerId, ":pm": loan.stripePaymentMethodId,
      },
    }));
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}
