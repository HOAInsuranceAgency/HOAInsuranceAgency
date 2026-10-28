import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const db = DynamoDBDocumentClient.from(new DynamoDBClient());
export type UserAccessStatus = { userId: string; disabled: boolean; revokedBefore?: number };

export class UserAccessDenied extends Error {
  constructor(message = "Your access is inactive. Contact an Owner to restore access.") {
    super(message);
    this.name = "Unauthorized";
  }
}

/** Access controls have their own server-only table, never an editable profile.
 * A consistent read makes a completed disable visible on the very next request.
 * Records and their authentication cutoff are retained across reactivation. */
export async function readUserAccess(userId: string, client = db): Promise<UserAccessStatus | undefined> {
  const TableName = process.env.USER_ACCESS_TABLE;
  if (!TableName) throw new Error("Team access controls are not configured.");
  const result = await client.send(new GetCommand({ TableName, Key: { userId }, ConsistentRead: true }));
  return result.Item as UserAccessStatus | undefined;
}

export async function teamUserDisabled(userId: string): Promise<boolean> {
  return (await readUserAccess(userId))?.disabled === true;
}

/** Couple ownership/delivery writes to the same status record the Owner
 * disables, so a candidate checked just before shutdown cannot slip through. */
export function activeTeamUserCheck(userId: string) {
  const TableName = process.env.USER_ACCESS_TABLE;
  if (!TableName) throw new Error("Team access controls are not configured.");
  return { ConditionCheck: {
    TableName, Key: { userId },
    ConditionExpression: "attribute_not_exists(#disabled) OR #disabled = :active",
    ExpressionAttributeNames: { "#disabled": "disabled" },
    ExpressionAttributeValues: { ":active": false },
  } };
}

/** AppSync validates JWT signatures/expiry, but does not consult Cognito's
 * disabled state. Check the persistent denial before data or file access.
 * auth_time identifies the original login; refreshing its JWT cannot turn a
 * revoked login into a new session after an Owner reactivates the account. */
export async function assertUserSession(identity: unknown, client = db): Promise<void> {
  const user = identity as { sub?: unknown; claims?: Record<string, unknown> } | null | undefined;
  const userId = user?.sub ?? user?.claims?.sub;
  if (typeof userId !== "string" || !userId) throw new UserAccessDenied("Sign in to access the CRM.");
  const status = await readUserAccess(userId, client);
  if (status?.disabled) throw new UserAccessDenied();
  if (status?.revokedBefore !== undefined) {
    const authenticatedAt = user?.claims?.auth_time;
    if (typeof authenticatedAt !== "number" || !Number.isSafeInteger(authenticatedAt) || authenticatedAt <= status.revokedBefore) {
      throw new UserAccessDenied("Your session was signed out. Sign in again to continue.");
    }
  }
}
