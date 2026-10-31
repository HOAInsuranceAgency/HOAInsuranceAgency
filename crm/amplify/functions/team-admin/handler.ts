import { TransactionalMailClient } from "../transactional-mail/client";
import { MailDeliveryError } from "../transactional-mail/contract";
import { randomUUID } from "node:crypto";
import type { AppSyncResolverEvent } from "aws-lambda";
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminUserGlobalSignOutCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
// Role names are the schema's `UserRole` and the Cognito group names both —
// see the note on `isUserRole`. enums.ts pulls in no runtime dependency, the
// way pagination.ts does not.
import { isUserRole, type UserRole } from "../../../src/lib/enums";
import { isActiveAdmin, isActiveOwner } from "../crm-access/active-role";
import { listTeamUsers, loadTeamProfile, type TeamRosterArgs } from "./roster";
import { assertUserSession, readUserAccess } from "../crm-access/user-status";

/**
 * Team administration for active Admin and Owner views. Only an active Owner
 * may grant or change Owner membership.
 *
 * inviteUser: creates the Cognito user passwordless (CONFIRMED, verified
 * email — ready for magic-link sign-in immediately), assigns one or two
 * role groups, and sends an invitation email pointing at the portal.
 */

const cognito = new CognitoIdentityProviderClient();
const ses = new TransactionalMailClient("invite");
const db = DynamoDBDocumentClient.from(new DynamoDBClient());

const POOL_ID = process.env.USER_POOL_ID!;
const PORTAL_URL = process.env.PORTAL_URL ?? "";
const INVITE_FROM = process.env.INVITE_FROM ?? "";

type InviteArgs = { email?: string | null; roles: unknown };
type UpdateRolesArgs = { userId?: string | null; roles?: unknown };
type SetEnabledArgs = { userId?: string | null; enabled?: unknown };

/** Reject malformed assignments before creating a user or changing any groups. */
function assignedRoles(raw: unknown): UserRole[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 2 ||
    !raw.every((role): role is UserRole => typeof role === "string" && isUserRole(role)) ||
    new Set(raw).size !== raw.length) return null;
  return raw;
}

const ROLE_ERROR = "Choose one or two different roles: Owner, Admin, Staff, or Producer.";
const OWNER_ERROR = "Only an Owner can assign or change Owner access.";

async function groupsFor(username: string) {
  const groups: string[] = [];
  let nextToken: string | undefined;
  do {
    const result = await cognito.send(new AdminListGroupsForUserCommand({
      UserPoolId: POOL_ID,
      Username: username,
      NextToken: nextToken,
    }));
    groups.push(...(result.Groups ?? []).flatMap(group => group.GroupName ? [group.GroupName] : []));
    nextToken = result.NextToken;
  } while (nextToken);
  return groups;
}

async function inviteUser(args: InviteArgs, invitedBy: string, owner: boolean) {
  const email = args.email?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "A valid email is required." };
  }
  const roles = assignedRoles(args.roles);
  if (!roles) return { ok: false, error: ROLE_ERROR };
  if (roles.includes("OWNER") && !owner) return { ok: false, error: OWNER_ERROR };
  let username: string;
  let invitationGeneration: string;

  try {
    const created = await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: POOL_ID,
        Username: email,
        // No password ever exists; SUPPRESS Cognito's own invite —
        // we send a portal-branded one below.
        MessageAction: "SUPPRESS",
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
        ],
      })
    );
    username = created.User?.Username ?? email;
    invitationGeneration = created.User?.Attributes?.find(attribute => attribute.Name === "sub")?.Value ?? randomUUID();
  } catch (err) {
    if (err instanceof UsernameExistsException) {
      return { ok: false, error: "That email is already on the team." };
    }
    throw err;
  }

  try {
    for (const group of roles) {
      await cognito.send(new AdminAddUserToGroupCommand({
        UserPoolId: POOL_ID, Username: username, GroupName: group,
      }));
    }

    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: INVITE_FROM,
        Destination: { ToAddresses: [email] },
        Content: {
          Simple: {
            Subject: { Data: "You're invited to the HOA Insurance CRM" },
            Body: {
              Text: {
                Data: `You've been invited to the HOA Insurance Agency CRM.\n\nSign in at ${PORTAL_URL} using this email address — we'll email you a sign-in link each time. No password needed.`,
              },
              Html: {
                Data: `
<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">
  <h2 style="color:#142a4c">HOA Insurance Agency CRM</h2>
  <p>You've been invited to the agency CRM (roles: <strong>${roles.join(" and ")}</strong>).</p>
  <p style="margin:28px 0">
    <a href="${PORTAL_URL}" style="background:#2e7dd1;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:600">Open the CRM</a>
  </p>
  <p style="color:#64748b;font-size:13px">Sign in with this email address — a sign-in link is emailed to you each time. No password needed.</p>
</div>`,
              },
            },
          },
        },
      }),
      { idempotencyKey: `invite:${invitationGeneration}` }
    );
  } catch (error) {
    if (error instanceof MailDeliveryError && error.state === "UNKNOWN") {
      return { ok: false, error: "The member was created, but invitation delivery is uncertain. Review the saved email delivery record before resending; the member can request a sign-in link." };
    }
    // Only a successful creation enters this block. Existing team members
    // are never removed by a failed or repeated invitation.
    try {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: POOL_ID, Username: username }));
    } catch (cleanupError) {
      console.error("Could not remove a failed invitation", { username, error, cleanupError });
      try {
        await cognito.send(new AdminDisableUserCommand({ UserPoolId: POOL_ID, Username: username }));
        return { ok: false, error: "The invitation failed. The incomplete account was disabled; contact an administrator to remove it before sending a new invitation." };
      } catch (disableError) {
        console.error("Could not disable the incomplete invited account", { username, disableError });
        return { ok: false, error: "The invitation failed and the incomplete account could not be removed or disabled. Review this member's access immediately before trying again." };
      }
    }
    console.error("Invitation rolled back", { username, error });
    return { ok: false, error: "The invitation could not be completed. The new account was removed; please try again." };
  }

  console.log(`Invited ${email} as ${roles.join(", ")} (by ${invitedBy})`);
  return { ok: true, email, roles };
}

async function updateUserRoles(args: UpdateRolesArgs, actor: { username: string; sub?: string; owner: boolean }) {
  const roles = assignedRoles(args.roles);
  if (!roles) return { ok: false, error: ROLE_ERROR };
  if (roles.includes("OWNER") && !actor.owner) return { ok: false, error: OWNER_ERROR };
  const userId = args.userId?.trim();
  if (!userId) return { ok: false, error: "A team member is required." };

  // Cognito accepts a local user's sub as Username. Resolve it to the pool's
  // canonical username so every group operation addresses the same member.
  const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: POOL_ID, Username: userId }));
  const username = user.Username!;
  const sub = user.UserAttributes?.find(attribute => attribute.Name === "sub")?.Value;
  const groups = await groupsFor(username);
  const previous = groups.filter(isUserRole);
  // Check the real Cognito membership, never the editable profile mirror.
  // Administrators must not promote themselves or downgrade another Owner.
  if (previous.includes("OWNER") && !actor.owner) return { ok: false, error: OWNER_ERROR };
  if (username === actor.username || (sub && sub === actor.sub)) {
    if (previous.includes("OWNER") && !roles.includes("OWNER")) {
      return { ok: false, error: "Keep your Owner role so you can continue managing owner access." };
    }
    if (previous.includes("ADMIN") && !roles.includes("ADMIN") && !roles.includes("OWNER")) {
      return { ok: false, error: "Keep your Admin role so you can continue managing team access." };
    }
  }

  // Add replacements before removing obsolete roles: a failed add cannot
  // strip someone's existing access. Unrelated Cognito groups are preserved.
  const added: UserRole[] = [], removed: UserRole[] = [];
  try {
    for (const role of roles.filter(role => !previous.includes(role))) {
      await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: POOL_ID, Username: username, GroupName: role }));
      added.push(role);
    }
    for (const role of previous.filter(role => !roles.includes(role))) {
      await cognito.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: POOL_ID, Username: username, GroupName: role }));
      removed.push(role);
    }
  } catch (error) {
    // Cognito has no group transaction. Restore completed writes if a later
    // operation fails, then make any failed restoration visible to the admin.
    const restored = await Promise.allSettled([
      ...removed.map(role => cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: POOL_ID, Username: username, GroupName: role }))),
      ...added.map(role => cognito.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: POOL_ID, Username: username, GroupName: role }))),
    ]);
    if (restored.some(result => result.status === "rejected")) {
      console.error("Could not restore role groups after failed update", { username, error });
      return { ok: false, error: "The role change only partly completed. Refresh the team and check this member's roles before trying again." };
    }
    throw error;
  }
  console.log(`Updated roles for ${username} to ${roles.join(", ")} (by ${actor.username})`);
  return { ok: true, userId: sub ?? userId, roles };
}

/** The handler has one reserved concurrent execution so opposite access
 * changes cannot race Cognito and the persistent session denial. All changes
 * remain retryable: a failed disable keeps CRM access denied; a failed restore
 * keeps that denial until Cognito enable and sign-out have both succeeded. */
async function setTeamUserEnabled(args: SetEnabledArgs, actor: { username: string; sub?: string }) {
  const userId = args.userId?.trim();
  if (!userId || typeof args.enabled !== "boolean") return { ok: false, error: "Choose a team member and an access status." };
  const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: POOL_ID, Username: userId }));
  const username = user.Username;
  const sub = user.UserAttributes?.find(attribute => attribute.Name === "sub")?.Value;
  if (!username || !sub) return { ok: false, error: "This team member's identity could not be verified." };
  if (!args.enabled && (username === actor.username || sub === actor.sub)) {
    return { ok: false, error: "You cannot deactivate your own access." };
  }
  const previous = await readUserAccess(sub, db);
  const enabled = user.Enabled !== false && previous?.disabled !== true;
  if (args.enabled && enabled) return { ok: true, userId: sub, enabled: true };
  const TableName = process.env.USER_ACCESS_TABLE!;
  const revokedBefore = Math.max(previous?.revokedBefore ?? 0, Math.floor(Date.now() / 1000));
  try {
    // Persist the denial before contacting Cognito. Cached JWTs can no longer
    // reach any CRM resolver even if a subsequent Cognito request fails.
    await db.send(new UpdateCommand({
      TableName, Key: { userId: sub },
      UpdateExpression: "SET #disabled = :disabled, revokedBefore = :cutoff, changedBy = :actor, updatedAt = :now",
      ExpressionAttributeNames: { "#disabled": "disabled" },
      ExpressionAttributeValues: { ":disabled": true, ":cutoff": revokedBefore, ":actor": actor.sub ?? actor.username, ":now": new Date().toISOString() },
    }));
  } catch (error) {
    console.error("Could not persist team access denial", { userId: sub, error });
    // A transport failure can follow a committed write. Read back the actual
    // denial rather than incorrectly telling the Owner that access stayed on.
    try {
      const current = await readUserAccess(sub, db);
      return { ok: false, userId: sub, enabled: user.Enabled !== false && current?.disabled !== true,
        error: "The access change could not be completed. Refresh the team and try again." };
    } catch {
      return { ok: false, userId: sub, error: "The access change could not be confirmed. Refresh the team before trying again." };
    }
  }
  if (!args.enabled) {
    let failed = false;
    try { await cognito.send(new AdminDisableUserCommand({ UserPoolId: POOL_ID, Username: username })); }
    catch (error) { failed = true; console.error("Could not disable team sign-in", { userId: sub, error }); }
    try { await cognito.send(new AdminUserGlobalSignOutCommand({ UserPoolId: POOL_ID, Username: username })); }
    catch (error) { failed = true; console.error("Could not sign out team sessions", { userId: sub, error }); }
    return failed
      ? { ok: false, userId: sub, enabled: false, error: "CRM access is blocked, but completing sign-in shutdown failed. Try Deactivate again." }
      : { ok: true, userId: sub, enabled: false };
  }
  try {
    // Revoke any refresh tokens left behind by an earlier partial shutdown.
    await cognito.send(new AdminUserGlobalSignOutCommand({ UserPoolId: POOL_ID, Username: username }));
    await cognito.send(new AdminEnableUserCommand({ UserPoolId: POOL_ID, Username: username }));
    const restored = await cognito.send(new AdminGetUserCommand({ UserPoolId: POOL_ID, Username: username }));
    if (restored.Enabled !== true) throw new Error("Cognito did not confirm enabled access.");
    await db.send(new UpdateCommand({
      TableName, Key: { userId: sub }, UpdateExpression: "SET #disabled = :disabled, updatedAt = :now",
      ExpressionAttributeNames: { "#disabled": "disabled" },
      ExpressionAttributeValues: { ":disabled": false, ":now": new Date().toISOString() },
    }));
  } catch (error) {
    console.error("Could not complete team access restoration", { userId: sub, error });
    // The final release may have committed despite a lost response.
    try {
      const current = await readUserAccess(sub, db);
      if (current?.disabled === false) return { ok: true, userId: sub, enabled: true };
    } catch {
      return { ok: false, userId: sub, error: "Reactivation could not be confirmed. Refresh the team before trying again." };
    }
    return { ok: false, userId: sub, enabled: false, error: "Access remains blocked because reactivation could not be completed. Try Reactivate again." };
  }
  return { ok: true, userId: sub, enabled: true };
}

export const handler = async (
  event: AppSyncResolverEvent<InviteArgs | UpdateRolesArgs | SetEnabledArgs | TeamRosterArgs>
) => {
  if (!isActiveAdmin(event.identity, event.request)) return { ok: false, error: "Admin access is required." };
  const invokedBy =
    (event.identity && "username" in event.identity && event.identity.username) ||
    "unknown";

  // The invocation payload doesn't always carry `info` — fall back to the
  // argument shape to tell the operations apart.
  const field =
    event.info?.fieldName ??
    ("enabled" in (event.arguments ?? {}) ? "setTeamUserEnabled" : "userId" in (event.arguments ?? {}) ? "updateUserRoles" : "email" in (event.arguments ?? {}) ? "inviteUser" : "listTeamUsers");
  if (field === "setTeamUserEnabled" && !isActiveOwner(event.identity, event.request)) {
    return { ok: false, error: "Only an Owner can deactivate or reactivate team access." };
  }
  await assertUserSession(event.identity, db);

  switch (field) {
    case "inviteUser":
      return inviteUser(event.arguments as InviteArgs, String(invokedBy), isActiveOwner(event.identity, event.request));
    case "updateUserRoles":
      return updateUserRoles(event.arguments as UpdateRolesArgs, {
        username: String(invokedBy),
        sub: event.identity && "sub" in event.identity ? event.identity.sub : undefined,
        owner: isActiveOwner(event.identity, event.request),
      });
    case "setTeamUserEnabled":
      return setTeamUserEnabled(event.arguments as SetEnabledArgs, {
        username: String(invokedBy),
        sub: event.identity && "sub" in event.identity ? event.identity.sub : undefined,
      });
    case "listTeamUsers":
      return listTeamUsers(cognito, POOL_ID, event.arguments as TeamRosterArgs, groupsFor,
        userId => loadTeamProfile(db, process.env.USER_PROFILE_TABLE_NAME!, process.env.USER_PROFILE_USER_ID_INDEX_NAME!, userId),
        async userId => (await readUserAccess(userId, db))?.disabled === true);
    default:
      return { ok: false, error: `Unknown field ${field}` };
  }
};
