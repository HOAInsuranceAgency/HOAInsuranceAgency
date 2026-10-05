import type { AppSyncResolverEvent } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminDeleteUserCommand, AdminDisableUserCommand, AdminGetUserCommand,
  AdminListGroupsForUserCommand, AdminRemoveUserFromGroupCommand, ListUsersCommand,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";

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
  dbSend.mockResolvedValue({ Items: [] });
  sesSend.mockResolvedValue({});
  cognitoSend.mockImplementation(async command => {
    if (command instanceof AdminGetUserCommand) return { Username: "member-username", UserAttributes: [{ Name: "sub", Value: "member-sub" }] };
    if (command instanceof AdminListGroupsForUserCommand) return { Groups: [{ GroupName: "ADMIN" }, { GroupName: "SUPPORT_REPORTING" }] };
    return {};
  });
});
afterEach(() => vi.unstubAllEnvs());

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
    dbSend.mockImplementation(async command => ({ Items: [{
      id: `profile-${command.input.ExpressionAttributeValues[":userId"]}`,
      userId: command.input.ExpressionAttributeValues[":userId"], firstName: "Casey", lastName: "Agent",
    }] }));
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
    expect(dbSend).toHaveBeenCalledOnce();
    expect(dbSend.mock.calls[0][0].input).toMatchObject({ TableName: "profiles", IndexName: "profiles-by-userId", Limit: 1 });
    expect(await run("listTeamUsers", { nextToken: "more-users" })).toMatchObject({ ok: true, nextToken: null, users: [
      { userId: "second", groups: ["ADMIN", "PRODUCER"] },
    ] });
    expect(dbSend).toHaveBeenCalledTimes(2);
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
