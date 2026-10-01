import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const cognito = new CognitoIdentityProviderClient();
const MAX_PAGES = 100;

/** Resolve sign-in availability without one Cognito request per teammate.
 * Missing users are unavailable only after a complete, successful listing. */
export async function availableTeamUsers(
  userIds: string[],
): Promise<Set<string>> {
  const pending = new Set(userIds),
    available = new Set<string>(),
    seen = new Set<string>();
  let token: string | undefined;
  if (!pending.size) return available;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await cognito.send(
      new ListUsersCommand({
        UserPoolId: process.env.USER_POOL_ID,
        Limit: 60,
        PaginationToken: token,
      }),
    );
    for (const user of result.Users ?? []) {
      const id = user.Attributes?.find(
        (attribute) => attribute.Name === "sub",
      )?.Value;
      if (!id || !pending.has(id)) continue;
      pending.delete(id);
      if (user.Enabled === true) available.add(id);
    }
    token = result.PaginationToken;
    if (!token || !pending.size) return available;
    if (seen.has(token))
      throw new Error(
        "Could not verify teammate availability. Refresh and try again.",
      );
    seen.add(token);
  }
  throw new Error("Could not verify all teammates. Refresh and try again.");
}
