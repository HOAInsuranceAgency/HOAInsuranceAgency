import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { TEAM_IDENTITY_LEASE_PREFIX, TEAM_IDENTITY_PARAMETER_PREFIX } from "./team-identity-config";

const leaseMs = 60_000; // Longer than either Lambda's invocation limit.
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 }));
const ssm = new SSMClient({ maxAttempts: 2 });
const tables = new Map<string, string>();

export class TeamIdentityBusy extends Error {}

async function lockTable(poolId?: string) {
  // Team Admin already has the table name. Google runs in the auth stack,
  // which cannot reference the data stack's table without creating a cycle.
  if (!poolId && process.env.USER_ACCESS_TABLE) return process.env.USER_ACCESS_TABLE;
  if (!poolId) throw new Error("Team identity coordination is not configured.");
  const known = tables.get(poolId);
  if (known) return known;
  const { Parameter } = await ssm.send(new GetParameterCommand({ Name: `${TEAM_IDENTITY_PARAMETER_PREFIX}${poolId}` }));
  if (!Parameter?.Value) throw new Error("Team identity coordination is not configured.");
  tables.set(poolId, Parameter.Value);
  return Parameter.Value;
}

/** Serialize Cognito identity changes across Team Admin and the Google trigger. */
export async function withTeamIdentityLock<T>(
  userId: string,
  work: (markWrite: () => void) => Promise<T>,
  poolId?: string,
): Promise<T> {
  const TableName = await lockTable(poolId);
  const Key = { userId: `${TEAM_IDENTITY_LEASE_PREFIX}${userId}` };
  const owner = randomUUID();
  const now = Date.now();
  try {
    await db.send(new UpdateCommand({
      TableName, Key,
      UpdateExpression: "SET leaseOwner = :owner, leaseUntil = :until",
      ConditionExpression: "attribute_not_exists(leaseUntil) OR leaseUntil <= :now",
      ExpressionAttributeValues: { ":owner": owner, ":until": now + leaseMs, ":now": now },
    }));
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") throw new TeamIdentityBusy();
    throw error;
  }

  let startedWrite = false;
  let completed = false;
  try {
    const result = await work(() => { startedWrite = true; });
    completed = true;
    return result;
  } finally {
    // A failed remote write may still commit. Leave the lease in place until
    // it expires if the caller could not confirm the result.
    if (completed || !startedWrite) {
      try {
        await db.send(new DeleteCommand({
          TableName, Key,
          ConditionExpression: "leaseOwner = :owner",
          ExpressionAttributeValues: { ":owner": owner },
        }));
      } catch {
        console.warn("Team identity lease release failed; the lease will expire.");
      }
    }
  }
}
