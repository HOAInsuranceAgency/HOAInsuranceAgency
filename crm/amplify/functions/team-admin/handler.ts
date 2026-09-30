import type { AppSyncResolverEvent } from "aws-lambda";
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  ListUsersCommand,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
// Role names are the schema's `UserRole` and the Cognito group names both —
// see the note on `isUserRole`. enums.ts pulls in no runtime dependency, the
// way pagination.ts does not.
import { DEFAULT_USER_ROLE, isUserRole, type UserRole } from "../../../src/lib/enums";
import { isActiveAdmin } from "../crm-access/active-role";

/**
 * Team administration behind ADMIN-group-only mutations.
 *
 * inviteUser: creates the Cognito user passwordless (CONFIRMED, verified
 * email — ready for magic-link sign-in immediately), assigns one or two
 * role groups, and sends an invitation email pointing at the portal.
 */

const cognito = new CognitoIdentityProviderClient();
const ses = new SESv2Client();

const POOL_ID = process.env.USER_POOL_ID!;
const PORTAL_URL = process.env.PORTAL_URL ?? "";
const INVITE_FROM = process.env.INVITE_FROM ?? "";

type InviteArgs = { email?: string | null; role?: string | null; roles?: unknown };
type UpdateRolesArgs = { userId?: string | null; roles?: unknown };

/** Reject malformed assignments before creating a user or changing any groups. */
function assignedRoles(raw: unknown): UserRole[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 2 ||
    !raw.every((role): role is UserRole => typeof role === "string" && isUserRole(role)) ||
    new Set(raw).size !== raw.length) return null;
  return raw;
}

const ROLE_ERROR = "Choose one or two different roles: Admin, Staff, or Producer.";

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

async function inviteUser(args: InviteArgs, invitedBy: string) {
  const email = args.email?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "A valid email is required." };
  }
  const roles = assignedRoles(args.roles ?? [args.role ?? DEFAULT_USER_ROLE]);
  if (!roles) return { ok: false, error: ROLE_ERROR };
  const role = roles[0];

  try {
    await cognito.send(
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
  } catch (err) {
    if (err instanceof UsernameExistsException) {
      return { ok: false, error: "That email is already on the team." };
    }
    throw err;
  }

  for (const group of roles) {
    await cognito.send(new AdminAddUserToGroupCommand({
      UserPoolId: POOL_ID, Username: email, GroupName: group,
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
    })
  );

  console.log(`Invited ${email} as ${roles.join(", ")} (by ${invitedBy})`);
  return { ok: true, email, role, roles };
}

async function updateUserRoles(args: UpdateRolesArgs, actor: { username: string; sub?: string }) {
  const roles = assignedRoles(args.roles);
  if (!roles) return { ok: false, error: ROLE_ERROR };
  const userId = args.userId?.trim();
  if (!userId) return { ok: false, error: "A team member is required." };

  // Cognito accepts a local user's sub as Username. Resolve it to the pool's
  // canonical username so every group operation addresses the same member.
  const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: POOL_ID, Username: userId }));
  const username = user.Username!;
  const sub = user.UserAttributes?.find(attribute => attribute.Name === "sub")?.Value;
  const groups = await groupsFor(username);
  const previous = groups.filter(isUserRole);
  if ((username === actor.username || (sub && sub === actor.sub)) && previous.includes("ADMIN") && !roles.includes("ADMIN")) {
    return { ok: false, error: "Keep your Admin role so you can continue managing team access." };
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
  return { ok: true, userId: sub ?? userId, role: roles[0], roles };
}

async function listTeamUsers() {
  const allUsers = [];
  let token: string | undefined;
  do {
    const result = await cognito.send(new ListUsersCommand({ UserPoolId: POOL_ID, Limit: 60, PaginationToken: token }));
    allUsers.push(...(result.Users ?? []));
    token = result.PaginationToken;
  } while (token);

  const users = await Promise.all(
    allUsers.map(async (u) => {
      const attrs = Object.fromEntries(
        (u.Attributes ?? []).map((a) => [a.Name, a.Value])
      );
      const groups = await groupsFor(u.Username!);
      return {
        userId: attrs.sub ?? u.Username,
        email: attrs.email ?? u.Username,
        status: u.UserStatus,
        enabled: u.Enabled ?? true,
        createdAt: u.UserCreateDate?.toISOString() ?? null,
        groups,
      };
    })
  );

  return { ok: true, users };
}

export const handler = async (
  event: AppSyncResolverEvent<InviteArgs | UpdateRolesArgs | Record<string, never>>
) => {
  if (!isActiveAdmin(event.identity, event.request)) return { ok: false, error: "Admin access is required." };
  const invokedBy =
    (event.identity && "username" in event.identity && event.identity.username) ||
    "unknown";

  // The invocation payload doesn't always carry `info` — fall back to the
  // argument shape to tell the two operations apart.
  const field =
    event.info?.fieldName ??
    ("userId" in (event.arguments ?? {}) ? "updateUserRoles" : "email" in (event.arguments ?? {}) ? "inviteUser" : "listTeamUsers");

  switch (field) {
    case "inviteUser":
      return inviteUser(event.arguments as InviteArgs, String(invokedBy));
    case "updateUserRoles":
      return updateUserRoles(event.arguments as UpdateRolesArgs, {
        username: String(invokedBy),
        sub: event.identity && "sub" in event.identity ? event.identity.sub : undefined,
      });
    case "listTeamUsers":
      return listTeamUsers();
    default:
      return { ok: false, error: `Unknown field ${field}` };
  }
};
