import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

/**
 * Custom mutation handler: reserveCertificateNumber.
 *
 * Atomically increments a per-year counter and returns the formatted
 * certificate number. A single UpdateItem is atomic in DynamoDB, so
 * concurrent callers always receive distinct, sequential numbers — no read /
 * modify / write race, no duplicates.
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());

const TABLE = process.env.SEQ_TABLE as string;
const PREFIX = process.env.CERT_PREFIX ?? "HOA";
// Per-year starting offsets for numbering that predates this system, e.g.
// {"2026": 10} → the first number issued in 2026 is HOA-2026-00011.
const BASES: Record<string, number> = (() => {
  try {
    return JSON.parse(process.env.CERT_SEQ_BASES ?? "{}");
  } catch {
    return {};
  }
})();

export const handler = async (): Promise<{
  certificateNumber: string;
  year: string;
  seq: number;
}> => {
  const year = String(new Date().getUTCFullYear());
  const base = BASES[year] ?? 0;

  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { year },
      // if_not_exists seeds the counter to `base` the first time a year is
      // used; every call after that just adds 1 to the stored value.
      UpdateExpression: "SET seq = if_not_exists(seq, :base) + :inc",
      ExpressionAttributeValues: { ":base": base, ":inc": 1 },
      ReturnValues: "ALL_NEW",
    })
  );

  const seq = Number(res.Attributes?.seq ?? 0);
  const certificateNumber = `${PREFIX}-${year}-${String(seq).padStart(5, "0")}`;
  return { certificateNumber, year, seq };
};
