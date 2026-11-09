import type { AppSyncResolverEvent } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminDeleteUserCommand, AdminDisableUserCommand, AdminEnableUserCommand, AdminUserGlobalSignOutCommand, AdminGetUserCommand,
  AdminDisableProviderForUserCommand, AdminListGroupsForUserCommand, AdminRemoveUserFromGroupCommand,
  AdminUpdateUserAttributesCommand, ListUsersCommand, UserNotFoundException,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import { DeleteCommand, GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const { cognitoSend, sesSend, dbSend } = vi.hoisted(() => ({ cognitoSend: vi.fn(), sesSend: vi.fn(), dbSend: vi.fn() }));
vi.mock("@aws-sdk/client-cognito-identity-provider", async importOriginal => ({
  ...await importOriginal<object>(),
  CognitoIdentityProviderClient: class { send = cognitoSend; },
}));
vi.mock("@aws-sdk/client-sesv2", async importOriginal => ({
  ...await importOriginal<object>(),
  SESv2Client: class { send = sesSend; },
}));
vi.mock("@aws-sdk/lib-dynamodb", async importOriginal => ({
  ...await importOriginal<object>(),
  DynamoDBDocumentClient: { from: () => ({ send: dbSend }) },
}));
import { handler } from "../../amplify/functions/team-admin/handler";

function run(fieldName: string, args: Record<string, unknown>, groups = ["ADMIN"], role?: string) {
  return handler({ arguments: args, info: { fieldName },
    identity: { username: "admin-username", sub: "admin-sub", groups },
    request: { headers: role ? { "x-crm-role": role } : {} },
  } as unknown as AppSyncResolverEvent<Parameters<typeof handler>[0]["arguments"]>);
}
const changes = () => cognitoSend.mock.calls.map(([command]) => command).filter(command =>
  command instanceof AdminAddUserToGroupCommand || command instanceof AdminRemoveUserFromGroupCommand);

beforeEach(() => {
  cognitoSend.mockReset(); sesSend.mockReset(); dbSend.mockReset();
  vi.stubEnv("USER_PROFILE_TABLE_NAME", "profiles");
  vi.stubEnv("USER_PROFILE_USER_ID_INDEX_NAME", "profiles-by-userId");
  vi.stubEnv("USER_ACCESS_TABLE", "user-access");
  dbSend.mockResolvedValue({ Items: [] });
  sesSend.mockResolvedValue({});
  cognitoSend.mockImplementation(async command => {
    if (command instanceof AdminGetUserCommand) return { Username: "member-username", UserAttributes: [{ Name: "sub", Value: "member-sub" }] };
    if (command instanceof AdminListGroupsForUserCommand) return { Groups: [{ GroupName: "ADMIN" }, { GroupName: "SUPPORT_REPORTING" }] };
    return {};
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("team email changes", () => {
  const userId = "member-sub";
  const oldEmail = "old@example.com";
  const email = "new@example.com";
  const google = JSON.stringify([{ providerName: "Google", userId: "google-subject", primary: "false" }]);

  function member({ enabled = true, identities, taken = false, updateError }: {
    enabled?: boolean; identities?: string; taken?: boolean; updateError?: Error;
  } = {}) {
    let currentEmail = oldEmail;
    let links = identities;
    cognitoSend.mockImplementation(async command => {
      if (command instanceof AdminGetUserCommand) {
        if (command.input.Username === email && currentEmail !== email) {
          if (taken) return { Username: "someone-else" };
          throw new UserNotFoundException({ $metadata: {}, message: "User does not exist." });
        }
        return { Username: "canonical-name", Enabled: enabled, UserStatus: "CONFIRMED", UserAttributes: [
          { Name: "sub", Value: userId },
          { Name: "email", Value: currentEmail },
          { Name: "email_verified", Value: "true" },
          ...(links ? [{ Name: "identities", Value: links }] : []),
        ] };
      }
      if (command instanceof AdminDisableUserCommand) enabled = false;
      if (command instanceof AdminEnableUserCommand) enabled = true;
      if (command instanceof AdminDisableProviderForUserCommand) links = undefined;
      if (command instanceof AdminUpdateUserAttributesCommand) {
        if (updateError) throw updateError;
        currentEmail = email;
      }
      return {};
    });
  }

  it("keeps the existing account and profile, disconnects the old Google sign-in and revokes sessions", async () => {
    member({ identities: google });
    dbSend.mockImplementation(async command => {
      if (command instanceof QueryCommand) return { Items: [{ id: "profile-id", userId, email: oldEmail }] };
      if (command instanceof GetCommand && command.input.Key?.userId === userId) return { Item: { disabled: true, revokedBefore: 4_000_000_000 } };
      return {};
    });
    expect(await run("updateTeamUserEmail", { userId, email: " New@Example.com " }, ["OWNER"])).toEqual({ ok: true, userId, email });
    const cognitoWrites = cognitoSend.mock.calls.map(([command]) => command).filter(command => !(command instanceof AdminGetUserCommand || command instanceof AdminListGroupsForUserCommand));
    expect(cognitoWrites.map(command => command.constructor)).toEqual([
      AdminDisableUserCommand, AdminDisableProviderForUserCommand, AdminUpdateUserAttributesCommand, AdminEnableUserCommand,
    ]);
    expect(cognitoWrites[1].input.User).toEqual({ ProviderName: "Google", ProviderAttributeName: "Cognito_Subject", ProviderAttributeValue: "google-subject" });
    expect(cognitoWrites[2].input).toMatchObject({
      Username: "canonical-name",
      UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }],
    });
    const updates = dbSend.mock.calls.map(([command]) => command).filter(command => command instanceof UpdateCommand);
    expect(updates[0].input).toMatchObject({
      TableName: "user-access", Key: { userId: `identity-lease:${userId}` },
      ConditionExpression: "attribute_not_exists(leaseUntil) OR leaseUntil <= :now",
    });
    expect(updates[1].input).toMatchObject({
      TableName: "user-access", Key: { userId },
      UpdateExpression: expect.stringContaining("if_not_exists(#disabled, :active)"),
      ExpressionAttributeValues: { ":cutoff": 4_000_000_000 },
    });
    expect(updates[2].input).toMatchObject({
      TableName: "profiles", Key: { id: "profile-id" },
      ConditionExpression: "userId = :userId",
      ExpressionAttributeValues: { ":userId": userId, ":email": email },
    });
    const release = dbSend.mock.calls.find(([command]) => command instanceof DeleteCommand)?.[0];
    expect(release?.input).toMatchObject({
      Key: updates[0].input.Key,
      ConditionExpression: "leaseOwner = :owner",
      ExpressionAttributeValues: { ":owner": updates[0].input.ExpressionAttributeValues[":owner"] },
    });
    expect(sesSend).not.toHaveBeenCalled();
  });

  it("rejects duplicate addresses, invalid addresses and unauthorized edits before any writes", async () => {
    member({ taken: true });
    expect(await run("updateTeamUserEmail", { userId, email }, ["OWNER"])).toMatchObject({ ok: false, error: "That email is already on the team." });
    expect(await run("updateTeamUserEmail", { userId, email: "not an email" }, ["OWNER"])).toMatchObject({ ok: false, error: "A valid email is required." });
    expect(await run("updateTeamUserEmail", { userId, email }, ["OWNER", "ADMIN"], "ADMIN")).toMatchObject({ ok: false, error: expect.stringContaining("Only an Owner") });
    expect(await run("updateTeamUserEmail", { userId, email }, ["ADMIN"])).toMatchObject({ ok: false, error: expect.stringContaining("Only an Owner") });
    expect(await run("updateTeamUserEmail", { userId, email }, ["PRODUCER"])).toMatchObject({ ok: false, error: "Admin access is required." });
    expect(cognitoSend.mock.calls.every(([command]) => command instanceof AdminGetUserCommand || command instanceof AdminListGroupsForUserCommand)).toBe(true);
    const nonLeaseCalls = dbSend.mock.calls.filter(([command]) => command.input.Key?.userId !== `identity-lease:${userId}`);
    expect(nonLeaseCalls.every(([command]) => command instanceof GetCommand)).toBe(true);
  });

  it("keeps an inactive account inactive and does not create a missing profile", async () => {
    member({ enabled: false });
    expect(await run("updateTeamUserEmail", { userId, email }, ["OWNER"])).toEqual({ ok: true, userId, email });
    expect(cognitoSend.mock.calls.some(([command]) => command instanceof AdminEnableUserCommand)).toBe(false);
    expect(dbSend.mock.calls.some(([command]) => command instanceof UpdateCommand && command.input.TableName === "profiles")).toBe(false);
  });

  it("restores prior sign-in access when the address cannot be saved", async () => {
    member({ updateError: new Error("unavailable") });
    expect(await run("updateTeamUserEmail", { userId, email }, ["OWNER"])).toMatchObject({ ok: false });
    expect(cognitoSend.mock.calls.at(-1)?.[0]).toBeInstanceOf(AdminEnableUserCommand);
    expect(dbSend.mock.calls.some(([command]) => command instanceof DeleteCommand)).toBe(false);
  });

  it("does not touch Cognito while Google linking holds the member's lease", async () => {
    dbSend.mockImplementation(async command => {
      if (command instanceof UpdateCommand) throw Object.assign(new Error("Lease already held"), { name: "ConditionalCheckFailedException" });
      return {};
    });
    expect(await run("updateTeamUserEmail", { userId, email }, ["OWNER"])).toMatchObject({
      ok: false, error: expect.stringContaining("sign-in update is in progress"),
    });
    expect(cognitoSend).not.toHaveBeenCalled();
    expect(dbSend.mock.calls.some(([command]) => command instanceof DeleteCommand)).toBe(false);
  });

  it("reports a partial profile failure and lets an identical retry repair the profile without revoking sessions again", async () => {
    member({ identities: google });
    let failProfile = true;
    dbSend.mockImplementation(async command => {
      if (command instanceof QueryCommand) return { Items: [{ id: "profile-id", userId, email: oldEmail }] };
      if (command instanceof UpdateCommand && command.input.TableName === "profiles" && failProfile) throw new Error("unavailable");
      return {};
    });
    expect(await run("updateTeamUserEmail", { userId, email }, ["OWNER"])).toMatchObject({ ok: false, userId, email, error: expect.stringContaining("profile") });
    failProfile = false;
    cognitoSend.mockClear();
    expect(await run("updateTeamUserEmail", { userId, email }, ["OWNER"])).toEqual({ ok: true, userId, email });
    expect(cognitoSend.mock.calls.every(([command]) => command instanceof AdminGetUserCommand || command instanceof AdminListGroupsForUserCommand)).toBe(true);
  });
});

describe("team role assignments", () => {
  it("invites a user with two actual Cognito memberships and one invitation", async () => {
    expect(await run("inviteUser", { email: " New@Example.com ", roles: ["ADMIN", "PRODUCER"] }))
      .toMatchObject({ ok: true, email: "new@example.com", roles: ["ADMIN", "PRODUCER"] });
    expect(cognitoSend.mock.calls.filter(([command]) => command instanceof AdminCreateUserCommand)).toHaveLength(1);
    expect(changes().map(command => command.input)).toEqual([
      expect.objectContaining({ Username: "new@example.com", GroupName: "ADMIN" }),
      expect.objectContaining({ Username: "new@example.com", GroupName: "PRODUCER" }),
    ]);
    expect(sesSend).toHaveBeenCalledTimes(1);
    expect(sesSend.mock.calls[0][0].input.Content.Simple.Body.Html.Data).toContain("ADMIN and PRODUCER");
  });

  it("requires explicit roles instead of falling back to a legacy role or default", async () => {
    expect(await run("inviteUser", { email: "one@example.com", role: "PRODUCER" })).toMatchObject({ ok: false });
    expect(await run("inviteUser", { email: "two@example.com" })).toMatchObject({ ok: false });
    expect(cognitoSend).not.toHaveBeenCalled();
    expect(sesSend).not.toHaveBeenCalled();
  });

  it.each([undefined, null, [], ["ADMIN", "STAFF", "PRODUCER"], ["ADMIN", "ADMIN"], ["SUPERADMIN"], [null], "ADMIN"].map(roles => ({ roles })))(
    "rejects invalid assignments before making any AWS calls ($roles)", async ({ roles }) => {
      expect(await run("inviteUser", { email: "new@example.com", roles })).toMatchObject({ ok: false });
      expect(await run("updateUserRoles", { userId: "member-sub", roles })).toMatchObject({ ok: false });
      expect(cognitoSend).not.toHaveBeenCalled();
      expect(sesSend).not.toHaveBeenCalled();
    },
  );

  it("requires Admin privileges and the active Admin view for reads and writes", async () => {
    for (const field of ["inviteUser", "updateUserRoles", "listTeamUsers"]) {
      expect(await run(field, { email: "new@example.com", userId: "member-sub", roles: ["ADMIN"] }, ["PRODUCER"]))
        .toMatchObject({ ok: false, error: "Admin access is required." });
      expect(await run(field, {}, ["ADMIN", "PRODUCER"], "PRODUCER")).toMatchObject({ ok: false });
    }
    expect(cognitoSend).not.toHaveBeenCalled();
    expect(dbSend).not.toHaveBeenCalled();
  });

  it("lets an Owner use admin functions without a paired Admin group", async () => {
    expect(await run("listTeamUsers", {}, ["OWNER"])).toMatchObject({ ok: true });
    expect(await run("inviteUser", { email: "owner@example.com", roles: ["OWNER", "PRODUCER"] }, ["OWNER"]))
      .toMatchObject({ ok: true, roles: ["OWNER", "PRODUCER"] });
    expect(changes().map(command => command.input.GroupName)).toEqual(["OWNER", "PRODUCER"]);
  });

  it.each([{ groups: ["ADMIN"] }, { groups: ["OWNER", "ADMIN"] }])("rejects Owner invitations and self-promotion from the Admin view ($groups)", async ({ groups }) => {
    for (const field of ["inviteUser", "updateUserRoles"]) {
      expect(await run(field, { email: "owner@example.com", userId: "admin-sub", roles: ["OWNER"] }, groups, "ADMIN"))
        .toMatchObject({ ok: false, error: expect.stringContaining("Only an Owner") });
    }
    expect(cognitoSend).not.toHaveBeenCalled();
    expect(sesSend).not.toHaveBeenCalled();
  });

  it("prevents an Admin from removing or changing any existing Owner roles", async () => {
    cognitoSend.mockImplementation(async command => command instanceof AdminGetUserCommand
      ? { Username: "owner", UserAttributes: [{ Name: "sub", Value: "owner-sub" }] }
      : { Groups: [{ GroupName: "OWNER" }, { GroupName: "PRODUCER" }] });
    expect(await run("updateUserRoles", { userId: "owner-sub", roles: ["ADMIN"] }))
      .toMatchObject({ ok: false, error: expect.stringContaining("Only an Owner") });
    expect(changes()).toHaveLength(0);
  });

  it("preserves an Owner's own access while permitting changes to another Owner", async () => {
    cognitoSend.mockImplementation(async command => command instanceof AdminGetUserCommand
      ? { Username: "owner-alias", UserAttributes: [{ Name: "sub", Value: "admin-sub" }] }
      : { Groups: [{ GroupName: "OWNER" }] });
    expect(await run("updateUserRoles", { userId: "admin-sub", roles: ["ADMIN"] }, ["OWNER"]))
      .toMatchObject({ ok: false, error: expect.stringContaining("Keep your Owner role") });
    expect(changes()).toHaveLength(0);
    cognitoSend.mockImplementation(async command => command instanceof AdminGetUserCommand
      ? { Username: "other-owner", UserAttributes: [{ Name: "sub", Value: "other-sub" }] }
      : command instanceof AdminListGroupsForUserCommand ? { Groups: [{ GroupName: "OWNER" }] } : {});
    expect(await run("updateUserRoles", { userId: "other-sub", roles: ["ADMIN"] }, ["OWNER"]))
      .toMatchObject({ ok: true, roles: ["ADMIN"] });
    expect(changes().map(command => [command.constructor.name, command.input.GroupName])).toEqual([
      ["AdminAddUserToGroupCommand", "ADMIN"], ["AdminRemoveUserFromGroupCommand", "OWNER"],
    ]);
  });

  it("removes Owner privileges when the Producer view is selected and rejects a forged Owner header", async () => {
    expect(await run("inviteUser", { email: "staff@example.com", roles: ["STAFF"] }, ["OWNER", "PRODUCER"], "PRODUCER"))
      .toMatchObject({ ok: false });
    await expect(run("listTeamUsers", {}, ["ADMIN"], "OWNER")).rejects.toThrow("not available");
    expect(cognitoSend).not.toHaveBeenCalled();
  });

  it("adds Producer to an existing admin without removing Admin or unrelated groups", async () => {
    expect(await run("updateUserRoles", { userId: "member-sub", roles: ["ADMIN", "PRODUCER"] }))
      .toMatchObject({ ok: true, userId: "member-sub", roles: ["ADMIN", "PRODUCER"] });
    expect(changes()).toHaveLength(1);
    expect(changes()[0]).toBeInstanceOf(AdminAddUserToGroupCommand);
    expect(changes()[0].input).toMatchObject({ Username: "member-username", GroupName: "PRODUCER" });
  });

  it("replaces obsolete memberships after additions and preserves unrelated groups", async () => {
    await run("updateUserRoles", { userId: "member-sub", roles: ["STAFF", "PRODUCER"] });
    expect(changes().map(command => [command.constructor.name, command.input.GroupName])).toEqual([
      ["AdminAddUserToGroupCommand", "STAFF"], ["AdminAddUserToGroupCommand", "PRODUCER"],
      ["AdminRemoveUserFromGroupCommand", "ADMIN"],
    ]);
  });

  it("prevents an admin from removing their own admin access, identified by sub", async () => {
    cognitoSend.mockImplementation(async command => command instanceof AdminGetUserCommand
      ? { Username: "different-alias", UserAttributes: [{ Name: "sub", Value: "admin-sub" }] }
      : { Groups: [{ GroupName: "ADMIN" }] });
    expect(await run("updateUserRoles", { userId: "admin-sub", roles: ["PRODUCER"] }))
      .toMatchObject({ ok: false, error: expect.stringContaining("Keep your Admin role") });
    expect(changes()).toHaveLength(0);
  });

  it("restores a completed addition if removing an obsolete role fails", async () => {
    cognitoSend.mockImplementation(async command => {
      if (command instanceof AdminGetUserCommand) return { Username: "member", UserAttributes: [{ Name: "sub", Value: "member-sub" }] };
      if (command instanceof AdminListGroupsForUserCommand) return { Groups: [{ GroupName: "STAFF" }] };
      if (command instanceof AdminRemoveUserFromGroupCommand && command.input.GroupName === "STAFF") throw new Error("Cognito unavailable");
      return {};
    });
    await expect(run("updateUserRoles", { userId: "member-sub", roles: ["PRODUCER"] })).rejects.toThrow("Cognito unavailable");
    expect(changes().map(command => [command.constructor.name, command.input.GroupName])).toEqual([
      ["AdminAddUserToGroupCommand", "PRODUCER"], ["AdminRemoveUserFromGroupCommand", "STAFF"],
      ["AdminRemoveUserFromGroupCommand", "PRODUCER"],
    ]);
  });

  it("returns one roster page and loads all memberships for only that page", async () => {
    dbSend.mockImplementation(async command => command instanceof QueryCommand ? ({ Items: [{
      id: `profile-${command.input.ExpressionAttributeValues![":userId"]}`,
      userId: command.input.ExpressionAttributeValues![":userId"], firstName: "Casey", lastName: "Agent",
    }] }) : {});
    cognitoSend.mockImplementation(async command => {
      if (command instanceof ListUsersCommand) return command.input.PaginationToken
        ? { Users: [{ Username: "second" }] }
        : { Users: [{ Username: "first" }], PaginationToken: "more-users" };
      if (command instanceof AdminListGroupsForUserCommand) return command.input.NextToken
        ? { Groups: [{ GroupName: "PRODUCER" }] }
        : { Groups: [{ GroupName: "ADMIN" }], NextToken: "more-groups" };
      return {};
    });
    const result = await run("listTeamUsers", {});
    expect(result).toMatchObject({ ok: true, nextToken: "more-users", profiles: [{ id: "profile-first", userId: "first", firstName: "Casey" }], users: [
      { userId: "first", groups: ["ADMIN", "PRODUCER"] },
    ] });
    expect(cognitoSend.mock.calls.filter(([command]) => command instanceof ListUsersCommand)).toHaveLength(1);
    expect(dbSend.mock.calls.filter(([command]) => command instanceof QueryCommand)).toHaveLength(1);
    expect(dbSend.mock.calls.find(([command]) => command instanceof QueryCommand)?.[0].input).toMatchObject({ TableName: "profiles", IndexName: "profiles-by-userId", Limit: 1 });
    expect(await run("listTeamUsers", { nextToken: "more-users" })).toMatchObject({ ok: true, nextToken: null, users: [
      { userId: "second", groups: ["ADMIN", "PRODUCER"] },
    ] });
    expect(dbSend.mock.calls.filter(([command]) => command instanceof QueryCommand)).toHaveLength(2);
  });
});

describe('complete role membership reads', () => {
  const incomplete = 'Team group membership could not be verified completely';
  const member = { Username: 'member', UserAttributes: [{ Name: 'sub', Value: 'member-sub' }] };

  it('refuses cyclic membership pages before any role mutation', async () => {
    let pages = 0;
    cognitoSend.mockImplementation(async command => {
      if (command instanceof AdminGetUserCommand) return member;
      if (command instanceof AdminListGroupsForUserCommand) return ++pages <= 2
        ? { Groups: [{ GroupName: 'ADMIN' }], NextToken: 'repeated' } : { Groups: [] };
      return {};
    });
    await expect(run('updateUserRoles', { userId: 'member-sub', roles: ['STAFF'] })).rejects.toThrow(incomplete);
    expect(pages).toBe(2);
    expect(changes()).toEqual([]);
  });

  it('refuses an exhausted membership page budget before changing access', async () => {
    let pages = 0;
    cognitoSend.mockImplementation(async command => {
      if (command instanceof AdminGetUserCommand) return member;
      if (command instanceof AdminListGroupsForUserCommand) return ++pages <= 20
        ? { Groups: [{ GroupName: 'ADMIN' }], NextToken: `page-${pages}` } : { Groups: [] };
      return {};
    });
    await expect(run('updateUserRoles', { userId: 'member-sub', roles: ['STAFF'] })).rejects.toThrow(incomplete);
    expect(pages).toBe(20);
    expect(changes()).toEqual([]);
  });

  it('preserves a late Cognito read failure and makes no role changes', async () => {
    const unavailable = new Error('Cognito membership read unavailable');
    cognitoSend.mockImplementation(async command => {
      if (command instanceof AdminGetUserCommand) return member;
      if (command instanceof AdminListGroupsForUserCommand) {
        if (command.input.NextToken) throw unavailable;
        return { Groups: [{ GroupName: 'ADMIN' }], NextToken: 'next' };
      }
      return {};
    });
    await expect(run('updateUserRoles', { userId: 'member-sub', roles: ['STAFF'] })).rejects.toBe(unavailable);
    expect(changes()).toEqual([]);
  });

  it('preserves every role and unrelated group across an empty membership page', async () => {
    cognitoSend.mockImplementation(async command => {
      if (command instanceof AdminGetUserCommand) return member;
      if (command instanceof AdminListGroupsForUserCommand) {
        if (!command.input.NextToken) return { Groups: [{ GroupName: 'ADMIN' }], NextToken: 'empty' };
        if (command.input.NextToken === 'empty') return { Groups: [], NextToken: 'last' };
        return { Groups: [{ GroupName: 'PRODUCER' }, { GroupName: 'SUPPORT_REPORTING' }] };
      }
      return {};
    });
    expect(await run('updateUserRoles', { userId: 'member-sub', roles: ['ADMIN', 'PRODUCER'] })).toMatchObject({ ok: true, roles: ['ADMIN', 'PRODUCER'] });
    expect(changes()).toEqual([]);
    expect(cognitoSend.mock.calls.filter(([command]) => command instanceof AdminListGroupsForUserCommand)).toHaveLength(3);
  });
});

describe("Owner account shutdown", () => {
  let status: Record<string, unknown> | undefined;
  let cognitoEnabled: boolean;
  beforeEach(() => {
    status = undefined;
    cognitoEnabled = true;
    dbSend.mockImplementation(async command => {
      if (command instanceof GetCommand) return { Item: command.input.Key?.userId === "member-sub" ? status : undefined };
      if (command instanceof UpdateCommand) {
        const values = command.input.ExpressionAttributeValues!;
        status = { ...status, userId: "member-sub", disabled: values[":disabled"],
          ...(values[":cutoff"] !== undefined ? { revokedBefore: values[":cutoff"] } : {}) };
      }
      return {};
    });
    cognitoSend.mockImplementation(async command => {
      if (command instanceof AdminGetUserCommand) return { Username: "canonical-member", Enabled: cognitoEnabled, UserAttributes: [{ Name: "sub", Value: "member-sub" }] };
      if (command instanceof AdminDisableUserCommand) cognitoEnabled = false;
      if (command instanceof AdminEnableUserCommand) cognitoEnabled = true;
      return {};
    });
  });

  it.each([[["ADMIN"], undefined], [["PRODUCER"], undefined], [["OWNER", "ADMIN"], "ADMIN"], [["OWNER", "PRODUCER"], "PRODUCER"]] as const)("requires the active Owner view (%j, %s)", async (groups, role) => {
    const result = await run("setTeamUserEnabled", { userId: "member-sub", enabled: false }, [...groups], role);
    expect(result).toMatchObject({ ok: false });
    expect(cognitoSend).not.toHaveBeenCalled(); expect(dbSend).not.toHaveBeenCalled();
  });

  it("denies the next CRM request before disabling Cognito and signing out all sessions, using the canonical username", async () => {
    cognitoSend.mockImplementation(async command => {
      if (command instanceof AdminGetUserCommand) return { Username: "canonical-member", Enabled: true, UserAttributes: [{ Name: "sub", Value: "member-sub" }] };
      expect(status).toMatchObject({ disabled: true, revokedBefore: expect.any(Number) });
      expect(command.input.Username).toBe("canonical-member");
      return {};
    });
    expect(await run("setTeamUserEnabled", { userId: "member-sub", enabled: false }, ["OWNER"]))
      .toEqual({ ok: true, userId: "member-sub", enabled: false });
    expect(cognitoSend.mock.calls.map(([command]) => command.constructor.name)).toEqual([
      "AdminGetUserCommand", "AdminDisableUserCommand", "AdminUserGlobalSignOutCommand",
    ]);
    expect(dbSend.mock.calls.filter(([command]) => command instanceof UpdateCommand)).toHaveLength(1);
    expect(await run("setTeamUserEnabled", { userId: "member-sub", enabled: false }, ["OWNER"]))
      .toMatchObject({ ok: true, enabled: false });
  });

  it.each(["admin-username", "different-alias"])("prevents self-deactivation through username or sub (%s)", async username => {
    cognitoSend.mockResolvedValue({ Username: username, Enabled: true, UserAttributes: [{ Name: "sub", Value: "admin-sub" }] });
    expect(await run("setTeamUserEnabled", { userId: "alias@example.com", enabled: false }, ["OWNER"]))
      .toMatchObject({ ok: false, error: "You cannot deactivate your own access." });
    expect(dbSend.mock.calls.some(([command]) => command instanceof UpdateCommand)).toBe(false);
    expect(cognitoSend).toHaveBeenCalledOnce();
  });

  it("keeps actual CRM access blocked and shows an incomplete sign-out failure, with a safe retry", async () => {
    cognitoSend.mockImplementation(async command => {
      if (command instanceof AdminGetUserCommand) return { Username: "canonical-member", Enabled: cognitoEnabled, UserAttributes: [{ Name: "sub", Value: "member-sub" }] };
      if (command instanceof AdminDisableUserCommand) cognitoEnabled = false;
      if (command instanceof AdminUserGlobalSignOutCommand) throw new Error("Cognito unavailable");
      return {};
    });
    expect(await run("setTeamUserEnabled", { userId: "member-sub", enabled: false }, ["OWNER"]))
      .toMatchObject({ ok: false, enabled: false, error: expect.stringContaining("CRM access is blocked") });
    expect(status?.disabled).toBe(true);
    cognitoSend.mockImplementation(async command => command instanceof AdminGetUserCommand
      ? { Username: "canonical-member", Enabled: false, UserAttributes: [{ Name: "sub", Value: "member-sub" }] } : {});
    expect(await run("setTeamUserEnabled", { userId: "member-sub", enabled: false }, ["OWNER"]))
      .toMatchObject({ ok: true, enabled: false });
  });

  it("keeps access blocked if Cognito disable fails and still attempts session sign-out", async () => {
    cognitoSend.mockImplementation(async command => {
      if (command instanceof AdminGetUserCommand) return { Username: "canonical-member", Enabled: true, UserAttributes: [{ Name: "sub", Value: "member-sub" }] };
      if (command instanceof AdminDisableUserCommand) throw new Error("Cognito unavailable");
      return {};
    });
    expect(await run("setTeamUserEnabled", { userId: "member-sub", enabled: false }, ["OWNER"]))
      .toMatchObject({ ok: false, enabled: false });
    expect(status?.disabled).toBe(true);
    expect(cognitoSend.mock.calls.some(([command]) => command instanceof AdminUserGlobalSignOutCommand)).toBe(true);
  });

  it("does not claim a shutdown or touch Cognito access when persisting denial fails", async () => {
    dbSend.mockImplementation(async command => {
      if (command instanceof UpdateCommand) throw new Error("DynamoDB unavailable");
      return {};
    });
    expect(await run("setTeamUserEnabled", { userId: "member-sub", enabled: false }, ["OWNER"]))
      .toMatchObject({ ok: false, enabled: true, error: expect.stringContaining("could not be completed") });
    expect(cognitoSend).toHaveBeenCalledOnce();
  });

  it("reactivates only after Cognito confirms enable and keeps the revoked authentication cutoff", async () => {
    status = { userId: "member-sub", disabled: true, revokedBefore: Math.floor(Date.now() / 1000) };
    cognitoEnabled = false;
    expect(await run("setTeamUserEnabled", { userId: "member-sub", enabled: true }, ["OWNER"]))
      .toEqual({ ok: true, userId: "member-sub", enabled: true });
    expect(status).toMatchObject({ disabled: false, revokedBefore: expect.any(Number) });
    expect(cognitoSend.mock.calls.map(([command]) => command.constructor.name)).toEqual([
      "AdminGetUserCommand", "AdminUserGlobalSignOutCommand", "AdminEnableUserCommand", "AdminGetUserCommand",
    ]);
    expect(await run("setTeamUserEnabled", { userId: "member-sub", enabled: true }, ["OWNER"]))
      .toMatchObject({ ok: true, enabled: true });
    expect(cognitoSend.mock.calls.filter(([command]) => command instanceof AdminEnableUserCommand)).toHaveLength(1);
  });

  it("reports actual blocked status when denial commits but its response is lost", async () => {
    dbSend.mockImplementation(async command => {
      if (command instanceof GetCommand) return { Item: command.input.Key?.userId === "member-sub" ? status : undefined };
      status = { userId: "member-sub", disabled: true, revokedBefore: 100 };
      throw new Error("Response lost");
    });
    expect(await run("setTeamUserEnabled", { userId: "member-sub", enabled: false }, ["OWNER"]))
      .toMatchObject({ ok: false, enabled: false });
    expect(cognitoSend).toHaveBeenCalledOnce();
  });

  it("confirms a completed reactivation when only the final status-write response was lost", async () => {
    status = { userId: "member-sub", disabled: true, revokedBefore: 100 }; cognitoEnabled = false;
    dbSend.mockImplementation(async command => {
      if (command instanceof GetCommand) return { Item: command.input.Key?.userId === "member-sub" ? status : undefined };
      const values = command.input.ExpressionAttributeValues!;
      status = { ...status, disabled: values[":disabled"] };
      if (values[":disabled"] === false) throw new Error("Response lost");
      return {};
    });
    expect(await run("setTeamUserEnabled", { userId: "member-sub", enabled: true }, ["OWNER"]))
      .toEqual({ ok: true, userId: "member-sub", enabled: true });
  });

  it("leaves CRM access denied when restoration only partly succeeds", async () => {
    status = { userId: "member-sub", disabled: true, revokedBefore: 100 };
    cognitoEnabled = false;
    dbSend.mockImplementation(async command => {
      if (command instanceof GetCommand) return { Item: command.input.Key?.userId === "member-sub" ? status : undefined };
      if (command instanceof UpdateCommand && command.input.ExpressionAttributeValues?.[":disabled"] === false) throw new Error("DynamoDB unavailable");
      return {};
    });
    expect(await run("setTeamUserEnabled", { userId: "member-sub", enabled: true }, ["OWNER"]))
      .toMatchObject({ ok: false, enabled: false, error: expect.stringContaining("Access remains blocked") });
  });

  it("rejects a disabled Owner's cached session before reading or modifying another user", async () => {
    dbSend.mockResolvedValue({ Item: { userId: "admin-sub", disabled: true } });
    await expect(run("setTeamUserEnabled", { userId: "member-sub", enabled: true }, ["OWNER"]))
      .rejects.toThrow("Your access is inactive");
    expect(cognitoSend).not.toHaveBeenCalled();
  });
});

describe("failed invitation recovery", () => {
  it.each(["ADMIN", "PRODUCER"])("removes the new account when adding %s fails and allows a clean retry", async failedGroup => {
    let exists = false, fail = true;
    const memberships = new Set<string>();
    cognitoSend.mockImplementation(async command => {
      if (command instanceof AdminCreateUserCommand) {
        if (exists) throw new UsernameExistsException({ message: "Exists", $metadata: {} });
        exists = true;
        return { User: { Username: "new-canonical-username" } };
      }
      expect(command.input.Username).toBe("new-canonical-username");
      if (command instanceof AdminAddUserToGroupCommand) {
        if (!command.input.GroupName) throw new Error("Missing assigned group");
        if (command.input.GroupName === failedGroup && fail) { fail = false; throw new Error("Group write failed"); }
        memberships.add(command.input.GroupName);
      }
      if (command instanceof AdminDeleteUserCommand) { exists = false; memberships.clear(); }
      return {};
    });
    const args = { email: "new@example.com", roles: ["ADMIN", "PRODUCER"] };
    expect(await run("inviteUser", args)).toMatchObject({ ok: false, error: expect.stringContaining("removed") });
    expect(exists).toBe(false); expect(memberships.size).toBe(0);
    expect(sesSend).not.toHaveBeenCalled();
    expect(await run("inviteUser", args)).toMatchObject({ ok: true, roles: args.roles });
    expect(exists).toBe(true); expect([...memberships]).toEqual(args.roles);
    expect(sesSend).toHaveBeenCalledOnce();
  });

  it("also rolls back the new account when sending the invitation fails", async () => {
    sesSend.mockRejectedValueOnce(new Error("Email temporarily unavailable"));
    const args = { email: "new@example.com", roles: ["ADMIN", "PRODUCER"] };
    expect(await run("inviteUser", args)).toMatchObject({ ok: false, error: expect.stringContaining("try again") });
    expect(cognitoSend.mock.calls.filter(([command]) => command instanceof AdminDeleteUserCommand)).toHaveLength(1);
    expect(await run("inviteUser", args)).toMatchObject({ ok: true });
  });

  it("never deletes or disables an existing team member on a repeated invitation", async () => {
    cognitoSend.mockRejectedValueOnce(new UsernameExistsException({ message: "Exists", $metadata: {} }));
    expect(await run("inviteUser", { email: "existing@example.com", roles: ["ADMIN"] }))
      .toMatchObject({ ok: false, error: "That email is already on the team." });
    expect(cognitoSend).toHaveBeenCalledOnce();
    expect(cognitoSend.mock.calls[0][0]).toBeInstanceOf(AdminCreateUserCommand);
    expect(sesSend).not.toHaveBeenCalled();
  });

  it.each([false, true])("reports manual recovery when rollback fails (disable failure: %s)", async disableFails => {
    cognitoSend.mockImplementation(async command => {
      if (command instanceof AdminAddUserToGroupCommand || command instanceof AdminDeleteUserCommand ||
        disableFails && command instanceof AdminDisableUserCommand) throw new Error("Cognito unavailable");
      return {};
    });
    const result = await run("inviteUser", { email: "new@example.com", roles: ["ADMIN", "PRODUCER"] });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(disableFails ? "Review this member's access immediately" : "account was disabled") });
    expect(cognitoSend.mock.calls.some(([command]) => command instanceof AdminDisableUserCommand)).toBe(true);
    expect(sesSend).not.toHaveBeenCalled();
  });
});
