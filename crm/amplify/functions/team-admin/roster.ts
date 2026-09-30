import {
  type CognitoIdentityProviderClient,
  ListUsersCommand,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";
import { QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export type TeamRosterArgs = { nextToken?: string | null };

const PAGE_SIZE = 20;
const GROUP_CONCURRENCY = 4;
const PROFILE_FIELDS = [
  "id", "userId", "email", "firstName", "lastName", "role", "npn",
  "onboardingComplete", "mobilePhone", "leadTextAlerts", "signatureKey", "createdAt", "updatedAt",
];
type TeamProfile = Record<string, unknown> & { id: string; userId: string };

/** UserProfile IDs are independent of Cognito subs, so use its existing GSI. */
export async function loadTeamProfile(
  db: DynamoDBDocumentClient,
  tableName: string,
  userIdIndexName: string,
  userId: string,
): Promise<TeamProfile | null> {
  if (!tableName || !userIdIndexName) throw new Error("Team profile lookup is not configured.");
  const names = Object.fromEntries(PROFILE_FIELDS.map((field, i) => [`#p${i}`, field]));
  const result = await db.send(new QueryCommand({
    TableName: tableName,
    IndexName: userIdIndexName,
    KeyConditionExpression: "#userId = :userId",
    ExpressionAttributeNames: { ...names, "#userId": "userId" },
    ExpressionAttributeValues: { ":userId": userId },
    ProjectionExpression: Object.keys(names).join(", "),
    Limit: 1,
  }));
  const profile = result.Items?.[0];
  if (!profile || profile.userId !== userId || typeof profile.id !== "string") return null;
  return Object.fromEntries(PROFILE_FIELDS.filter(field => profile[field] !== undefined).map(field => [field, profile[field]])) as TeamProfile;
}

/** One bounded page per request, including its optional profile decorations. */
export async function listTeamUsers(
  cognito: CognitoIdentityProviderClient,
  poolId: string,
  args: TeamRosterArgs,
  groupsFor: (username: string) => Promise<string[]>,
  profileFor: (userId: string) => Promise<TeamProfile | null> = async () => null,
) {
  const token = args.nextToken;
  if (token != null && (typeof token !== "string" || !token.trim() || token.length > 131072)) {
    return { ok: false, error: "Invalid team page token." };
  }
  const page = await cognito.send(new ListUsersCommand({
    UserPoolId: poolId,
    Limit: PAGE_SIZE,
    PaginationToken: token ?? undefined,
  }));
  const members = page.Users ?? [];
  const describe = async (user: UserType) => {
    if (!user.Username) throw new Error("Team member is missing a Cognito username.");
    const attrs = Object.fromEntries((user.Attributes ?? []).map(attribute => [attribute.Name, attribute.Value]));
    const userId = attrs.sub ?? user.Username;
    const groups = await groupsFor(user.Username);
    // A missing/failed decoration must not prevent role administration. The
    // same four workers cap the indexed reads as well as Cognito lookups.
    let profile: TeamProfile | null = null;
    try { profile = await profileFor(userId); }
    catch (error) { console.warn("Could not load team profile", { userId, error }); }
    return {
      user: {
        userId,
        email: attrs.email ?? user.Username,
        status: user.UserStatus,
        enabled: user.Enabled ?? true,
        createdAt: user.UserCreateDate?.toISOString() ?? null,
        groups,
      },
      profile,
    };
  };
  const users: Awaited<ReturnType<typeof describe>>[] = new Array(members.length);
  let index = 0;
  let failed = false;
  let failure: unknown;
  // A failed lookup aborts the page. Let already-running reads settle before
  // rejecting, so a retry cannot pile another worker pool onto abandoned work.
  await Promise.all(Array.from({ length: Math.min(GROUP_CONCURRENCY, members.length) }, async () => {
    while (!failed && index < members.length) {
      const position = index++;
      try {
        users[position] = await describe(members[position]);
      } catch (error) {
        failed = true;
        failure = error;
      }
    }
  }));
  if (failed) throw failure;
  return {
    ok: true,
    users: users.map(member => member.user),
    profiles: users.flatMap(member => member.profile ? [member.profile] : []),
    nextToken: page.PaginationToken ?? null,
  };
}
