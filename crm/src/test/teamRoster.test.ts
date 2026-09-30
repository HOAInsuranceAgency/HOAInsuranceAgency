import { describe, expect, it, vi } from "vitest";
import { type CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { listTeamUsers, loadTeamProfile } from "../../amplify/functions/team-admin/roster";

function mockCognito(send: ReturnType<typeof vi.fn>) {
  return { send } as unknown as CognitoIdentityProviderClient;
}
const member = (index: number) => ({ Username: `member-${index}`, Attributes: [{ Name: "sub", Value: `sub-${index}` }] });

describe("bounded team roster pages", () => {
  it("returns one fixed-size page and passes its opaque cursor to the next request", async () => {
    const send = vi.fn().mockResolvedValueOnce({ Users: [member(1)], PaginationToken: "opaque-next-token" })
      .mockResolvedValueOnce({ Users: [member(2)] });
    const client = mockCognito(send);
    const groupsFor = vi.fn().mockResolvedValue(["ADMIN", "PRODUCER"]);
    expect(await listTeamUsers(client, "pool", {}, groupsFor)).toMatchObject({
      ok: true, users: [{ userId: "sub-1", groups: ["ADMIN", "PRODUCER"] }], nextToken: "opaque-next-token",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBeInstanceOf(ListUsersCommand);
    expect(send.mock.calls[0][0].input).toEqual({ UserPoolId: "pool", Limit: 20, PaginationToken: undefined });
    expect(await listTeamUsers(client, "pool", { nextToken: "opaque-next-token" }, groupsFor))
      .toMatchObject({ users: [{ userId: "sub-2" }], nextToken: null });
    expect(send.mock.calls[1][0].input).toEqual({ UserPoolId: "pool", Limit: 20, PaginationToken: "opaque-next-token" });
  });

  it("caps group lookups at four while retaining Cognito's member order", async () => {
    const send = vi.fn().mockResolvedValue({ Users: Array.from({ length: 20 }, (_, index) => member(index)) });
    let active = 0;
    let maximum = 0;
    const groupsFor = vi.fn(async (username: string) => {
      maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setTimeout(resolve, username.endsWith("0") ? 3 : 0));
      active--;
      return [username === "member-0" ? "ADMIN" : "STAFF"];
    });
    const result = await listTeamUsers(mockCognito(send), "pool", {}, groupsFor);
    expect(maximum).toBe(4);
    expect(groupsFor).toHaveBeenCalledTimes(20);
    expect(result.users?.map(user => user.userId)).toEqual(Array.from({ length: 20 }, (_, index) => `sub-${index}`));
  });

  it("includes only this page's profiles, with at most four profile reads at once", async () => {
    const send = vi.fn().mockResolvedValue({ Users: Array.from({ length: 20 }, (_, index) => member(index)), PaginationToken: "later-page" });
    let active = 0;
    let maximum = 0;
    const profileFor = vi.fn(async (userId: string) => {
      maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setTimeout(resolve, 0));
      active--;
      return { id: `profile-${userId}`, userId, firstName: "Casey" };
    });
    const result = await listTeamUsers(mockCognito(send), "pool", {}, async () => ["STAFF"], profileFor);
    expect(maximum).toBe(4);
    expect(profileFor).toHaveBeenCalledTimes(20);
    expect(profileFor.mock.calls.map(([userId]) => userId)).toEqual(Array.from({ length: 20 }, (_, index) => `sub-${index}`));
    expect(result.profiles).toHaveLength(20);
    expect(result.profiles?.[0]).toEqual({ id: "profile-sub-0", userId: "sub-0", firstName: "Casey" });
    expect(result.nextToken).toBe("later-page");
    expect(send).toHaveBeenCalledOnce();
  });

  it("keeps the page and roles available when some optional profiles are missing or fail", async () => {
    const send = vi.fn().mockResolvedValue({ Users: [member(1), member(2), member(3)] });
    const profileFor = vi.fn(async (userId: string) => {
      if (userId === "sub-1") throw new Error("Profile service unavailable");
      return userId === "sub-2" ? null : { id: "profile-three", userId };
    });
    const result = await listTeamUsers(mockCognito(send), "pool", {}, async () => ["PRODUCER"], profileFor);
    expect(result).toMatchObject({ ok: true, profiles: [{ id: "profile-three", userId: "sub-3" }], nextToken: null });
    expect(result.users?.map(user => [user.userId, user.groups])).toEqual([
      ["sub-1", ["PRODUCER"]], ["sub-2", ["PRODUCER"]], ["sub-3", ["PRODUCER"]],
    ]);
  });

  it("rejects a failed page only after pending group reads settle, without starting more work", async () => {
    const send = vi.fn().mockResolvedValue({ Users: Array.from({ length: 20 }, (_, index) => member(index)) });
    let settle!: () => void;
    const waiting = new Promise<string[]>(resolve => { settle = () => resolve(["STAFF"]); });
    const groupsFor = vi.fn((username: string) => username === "member-0" ? Promise.reject(new Error("Cognito throttled")) : waiting);
    let settled = false;
    const read = listTeamUsers(mockCognito(send), "pool", {}, groupsFor).finally(() => { settled = true; });
    const rejected = expect(read).rejects.toThrow("Cognito throttled");
    await vi.waitFor(() => expect(groupsFor).toHaveBeenCalledTimes(4));
    expect(settled).toBe(false);
    settle();
    await rejected;
    expect(groupsFor).toHaveBeenCalledTimes(4);
  });

  it.each(["", "   ", 123, "x".repeat(131073)])("rejects an invalid cursor without AWS reads", async nextToken => {
    const send = vi.fn();
    expect(await listTeamUsers(mockCognito(send), "pool", { nextToken } as { nextToken: string }, vi.fn()))
      .toEqual({ ok: false, error: "Invalid team page token." });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("indexed team profile decorations", () => {
  it("uses a bounded userId query and returns only roster profile fields", async () => {
    const send = vi.fn().mockResolvedValue({ Items: [{
      id: "random-profile-id", userId: "member-sub", firstName: "Casey", lastName: "Agent", signatureKey: "signatures/p.png",
      leadTextAlerts: true, mobilePhone: "5085550100", onboardingComplete: true, internalMetadata: "not returned",
    }] });
    const result = await loadTeamProfile({ send } as unknown as DynamoDBDocumentClient, "profiles", "by-userId", "member-sub");
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
    expect(send.mock.calls[0][0].input).toMatchObject({
      TableName: "profiles", IndexName: "by-userId", KeyConditionExpression: "#userId = :userId",
      ExpressionAttributeValues: { ":userId": "member-sub" }, Limit: 1,
    });
    expect(send.mock.calls[0][0].input.FilterExpression).toBeUndefined();
    expect(result).toEqual({
      id: "random-profile-id", userId: "member-sub", firstName: "Casey", lastName: "Agent", signatureKey: "signatures/p.png",
      leadTextAlerts: true, mobilePhone: "5085550100", onboardingComplete: true,
    });
  });

  it("does not attach a mismatched profile to a team member", async () => {
    const send = vi.fn().mockResolvedValue({ Items: [{ id: "other-profile", userId: "other-sub" }] });
    expect(await loadTeamProfile({ send } as unknown as DynamoDBDocumentClient, "profiles", "by-userId", "member-sub")).toBeNull();
  });
});
