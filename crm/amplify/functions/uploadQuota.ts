import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

/**
 * Reserving one upload slot, atomically.
 *
 * ## Why not the data client
 *
 * Both public upload handlers used to read a count, compare it to a ceiling,
 * create a Document, then write back count-plus-one. Two requests on one token
 * overlap and both read the same below-limit value, so both proceed and both
 * write the same number — more files accepted than the ceiling allows, and a
 * stored counter that is lower than the number of files that actually landed.
 *
 * Amplify's data client cannot express a conditional or atomic update, so this
 * goes to DynamoDB directly. A single `UpdateItem` with a condition is atomic,
 * which is the same technique `cert-number` already uses to hand out gap-free
 * certificate numbers under concurrency.
 *
 * ## Reserve first, then use
 *
 * The caller increments *before* creating the Document. If the create then
 * fails, the count is one higher than the number of files — so the account has
 * one fewer upload than its ceiling allows. That is the direction to be wrong
 * in: refusing one extra upload is a nuisance, accepting unlimited ones on a
 * public endpoint is not.
 *
 * ## What this does not touch
 *
 * Only `uploadCount`. Every other field on the row stays with the data client,
 * so a raw write here can never clobber a status or a deadline.
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());

/**
 * Take one slot, or refuse.
 *
 * Returns the new count when a slot was taken, and null when the ceiling is
 * already reached. Throws only on a real failure — a caller that cannot tell a
 * full quota from a broken table would have to guess, and guessing "allow" on
 * a public endpoint is how a bucket fills up.
 */
export async function reserveUploadSlot(opts: {
  tableName: string;
  id: string;
  max: number;
}): Promise<number | null> {
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: opts.tableName,
        Key: { id: opts.id },
        UpdateExpression: "SET uploadCount = if_not_exists(uploadCount, :zero) + :one",
        // `attribute_not_exists` covers a row that has never taken an upload,
        // where the column is absent rather than zero.
        ConditionExpression:
          "attribute_not_exists(uploadCount) OR uploadCount < :max",
        ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":max": opts.max },
        ReturnValues: "UPDATED_NEW",
      })
    );
    return Number(res.Attributes?.uploadCount ?? 1);
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
      return null;
    }
    throw err;
  }
}
