import {
  type CognitoIdentityProviderClient,
  ListUsersCommand,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";

export type TeamRosterArgs = { nextToken?: string | null };

const PAGE_SIZE = 20;
const GROUP_CONCURRENCY = 4;

/** One bounded page per request; group reads have a separate concurrency cap. */
export async function listTeamUsers(
  cognito: CognitoIdentityProviderClient,
  poolId: string,
  args: TeamRosterArgs,
  groupsFor: (username: string) => Promise<string[]>,
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
    return {
      userId: attrs.sub ?? user.Username,
      email: attrs.email ?? user.Username,
      status: user.UserStatus,
      enabled: user.Enabled ?? true,
      createdAt: user.UserCreateDate?.toISOString() ?? null,
      groups: await groupsFor(user.Username),
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
  return { ok: true, users, nextToken: page.PaginationToken ?? null };
}
