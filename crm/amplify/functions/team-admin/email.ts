import {
  AdminDisableProviderForUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminUpdateUserAttributesCommand,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { readUserAccess } from "../crm-access/user-status";
import { loadTeamProfile } from "./roster";

export type UpdateEmailArgs = { userId?: string | null; email?: string | null };
type Dependencies = {
  cognito: CognitoIdentityProviderClient;
  db: DynamoDBDocumentClient;
  poolId: string;
  actorId: string;
};

const fail = (error: string) => ({ ok: false as const, error });
const errorName = (error: unknown) => error instanceof Error ? error.name : "";
const inUse = "That email is already on the team.";

/** Only de-link identities created by our Google sign-in flow. */
function googleSubjects(identities: string | undefined): string[] {
  if (!identities) return [];
  const links = JSON.parse(identities);
  if (!Array.isArray(links)) throw new Error("Invalid provider identities.");
  return links.map(link => {
    if (link?.providerName !== "Google" || ![false, "false"].includes(link.primary) ||
        typeof link.userId !== "string" || !link.userId) {
      throw new Error("Unsupported provider identity.");
    }
    return link.userId;
  });
}

export async function updateTeamUserEmail(args: UpdateEmailArgs, { cognito, db, poolId, actorId }: Dependencies) {
  const email = typeof args.email === "string" ? args.email.trim().toLowerCase() : "";
  const userId = typeof args.userId === "string" ? args.userId.trim() : "";
  if (!userId) return fail("A team member is required.");
  if (email.length > 128 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("A valid email is required.");

  const getUser = (Username: string) => cognito.send(new AdminGetUserCommand({ UserPoolId: poolId, Username }));
  const user = await getUser(userId).catch(error => {
    if (errorName(error) === "UserNotFoundException") return null;
    throw error;
  });
  if (!user) return fail("This team member could not be found.");
  const username = user.Username;
  const attr = (name: string) => user.UserAttributes?.find(attribute => attribute.Name === name)?.Value;
  if (!username || attr("sub") !== userId || typeof user.Enabled !== "boolean") {
    return fail("This team member's identity could not be verified.");
  }
  const currentEmail = attr("email");
  const changeSignIn = currentEmail !== email || attr("email_verified") !== "true";
  let subjects: string[] = [];
  if (changeSignIn) {
    if (user.UserStatus === "EXTERNAL_PROVIDER") return fail("This account's email is managed by its sign-in provider.");
    try { subjects = googleSubjects(attr("identities")); }
    catch { return fail("This account's linked sign-in provider must be updated by an administrator."); }
    try {
      if ((await getUser(email)).Username !== username) return fail(inUse);
    } catch (error) {
      if (errorName(error) !== "UserNotFoundException") throw error;
    }
  }

  const profileTable = process.env.USER_PROFILE_TABLE_NAME!;
  const profile = await loadTeamProfile(db, profileTable, process.env.USER_PROFILE_USER_ID_INDEX_NAME!, userId);
  const updateProfile = async () => {
    if (!profile) return;
    // The GSI can still show the previous email on a quick A → B → A edit.
    // Use it only to locate the base record; never skip its update on that read.
    await db.send(new UpdateCommand({
      TableName: profileTable, Key: { id: profile.id },
      ConditionExpression: "userId = :userId",
      UpdateExpression: "SET email = :email, updatedAt = :now",
      ExpressionAttributeValues: { ":userId": userId, ":email": email, ":now": new Date().toISOString() },
    }));
  };

  let confirmedEmail = !changeSignIn;
  let restoreAccess = false;
  let failure: string | undefined;
  try {
    if (changeSignIn) {
      // A disabled Cognito member cannot start a new sign-in or re-link Google
      // to the previous address. Disabling also revokes Cognito sessions.
      if (user.Enabled) {
        restoreAccess = true;
        await cognito.send(new AdminDisableUserCommand({ UserPoolId: poolId, Username: username }));
        const disabled = await getUser(username);
        if (disabled.Enabled !== false) throw new Error("Cognito did not confirm the sign-in pause.");
        // Google may have linked just before sign-in was paused.
        subjects = googleSubjects(disabled.UserAttributes?.find(attribute => attribute.Name === "identities")?.Value);
      }
      const access = await readUserAccess(userId, db);
      // AppSync accepts already issued JWTs until expiry. Keep the existing
      // access state and advance the CRM's cutoff for those sessions.
      const cutoff = Math.max(access?.revokedBefore ?? 0, Math.floor(Date.now() / 1000));
      await db.send(new UpdateCommand({
        TableName: process.env.USER_ACCESS_TABLE!, Key: { userId },
        UpdateExpression: "SET #disabled = if_not_exists(#disabled, :active), revokedBefore = :cutoff, changedBy = :actor, updatedAt = :now",
        ExpressionAttributeNames: { "#disabled": "disabled" },
        ExpressionAttributeValues: { ":active": false, ":cutoff": cutoff, ":actor": actorId, ":now": new Date().toISOString() },
      }));
      for (const subject of subjects) {
        await cognito.send(new AdminDisableProviderForUserCommand({
          UserPoolId: poolId,
          User: { ProviderName: "Google", ProviderAttributeName: "Cognito_Subject", ProviderAttributeValue: subject },
        }));
      }
      await cognito.send(new AdminUpdateUserAttributesCommand({
        UserPoolId: poolId, Username: username,
        UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }],
      }));
      const updated = await getUser(username);
      const attributes = Object.fromEntries(updated.UserAttributes?.map(({ Name, Value }) => [Name, Value]) ?? []);
      if (updated.Username !== username || attributes.sub !== userId || attributes.email !== email ||
          attributes.email_verified !== "true" || googleSubjects(attributes.identities).length) {
        throw new Error("Cognito did not confirm the updated sign-in.");
      }
      confirmedEmail = true;
    }
    await updateProfile();
  } catch (error) {
    console.error("Could not complete team email change", { userId, error: errorName(error) });
    failure = confirmedEmail
      ? "The sign-in email is set, but the CRM profile could not be saved. Try again."
      : ["AliasExistsException", "UsernameExistsException"].includes(errorName(error))
        ? inUse
        : "The email change could not be confirmed. Refresh the team and check the address before trying again.";
  } finally {
    if (restoreAccess) {
      try { await cognito.send(new AdminEnableUserCommand({ UserPoolId: poolId, Username: username })); }
      catch (error) {
        console.error("Could not restore Cognito access after team email change", { userId, error: errorName(error) });
        failure = "Sign-in could not be restored. Refresh the team and ask an Owner to check this member's access.";
      }
    }
  }
  if (failure) return { ...fail(failure), ...(confirmedEmail ? { userId, email } : {}) };
  console.info("Updated team sign-in email", { userId, actorId });
  return { ok: true, userId, email };
}
