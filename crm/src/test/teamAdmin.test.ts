import type { AppSyncResolverEvent } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminGetUserCommand,
  AdminListGroupsForUserCommand, AdminRemoveUserFromGroupCommand, ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const { cognitoSend, sesSend } = vi.hoisted(() => ({ cognitoSend: vi.fn(), sesSend: vi.fn() }));
vi.mock("@aws-sdk/client-cognito-identity-provider", async importOriginal => ({
  ...await importOriginal<object>(),
  CognitoIdentityProviderClient: class { send = cognitoSend; },
}));
vi.mock("@aws-sdk/client-sesv2", async importOriginal => ({
  ...await importOriginal<object>(),
  SESv2Client: class { send = sesSend; },
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
  cognitoSend.mockReset(); sesSend.mockReset();
  sesSend.mockResolvedValue({});
  cognitoSend.mockImplementation(async command => {
    if (command instanceof AdminGetUserCommand) return { Username: "member-username", UserAttributes: [{ Name: "sub", Value: "member-sub" }] };
    if (command instanceof AdminListGroupsForUserCommand) return { Groups: [{ GroupName: "ADMIN" }, { GroupName: "SUPPORT_REPORTING" }] };
    return {};
  });
});

describe("team role assignments", () => {
  it("invites a user with two actual Cognito memberships and one invitation", async () => {
    expect(await run("inviteUser", { email: " New@Example.com ", roles: ["ADMIN", "PRODUCER"] }))
      .toMatchObject({ ok: true, email: "new@example.com", role: "ADMIN", roles: ["ADMIN", "PRODUCER"] });
    expect(cognitoSend.mock.calls.filter(([command]) => command instanceof AdminCreateUserCommand)).toHaveLength(1);
    expect(changes().map(command => command.input)).toEqual([
      expect.objectContaining({ Username: "new@example.com", GroupName: "ADMIN" }),
      expect.objectContaining({ Username: "new@example.com", GroupName: "PRODUCER" }),
    ]);
    expect(sesSend).toHaveBeenCalledTimes(1);
    expect(sesSend.mock.calls[0][0].input.Content.Simple.Body.Html.Data).toContain("ADMIN and PRODUCER");
  });

  it("keeps the legacy role and omitted-role invitation contract", async () => {
    expect(await run("inviteUser", { email: "one@example.com", role: "PRODUCER" })).toMatchObject({ ok: true, roles: ["PRODUCER"] });
    expect(await run("inviteUser", { email: "two@example.com" })).toMatchObject({ ok: true, roles: ["STAFF"] });
  });

  it.each([[], ["ADMIN", "STAFF", "PRODUCER"], ["ADMIN", "ADMIN"], ["SUPERADMIN"], [null], "ADMIN"].map(roles => ({ roles })))(
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

  it("lists every page of members and their group memberships", async () => {
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
    expect(result).toMatchObject({ ok: true, users: [
      { userId: "first", groups: ["ADMIN", "PRODUCER"] },
      { userId: "second", groups: ["ADMIN", "PRODUCER"] },
    ] });
  });
});
