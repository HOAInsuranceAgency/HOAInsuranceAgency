import { beforeEach, expect, it, vi } from "vitest";
import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { assertUserSession, readUserAccess } from "../../amplify/functions/crm-access/user-status";

const send = vi.fn();
const client = { send } as unknown as DynamoDBDocumentClient;
beforeEach(() => { process.env.USER_ACCESS_TABLE = "access-status"; send.mockReset().mockResolvedValue({}); });

it("uses an uncached, strongly consistent lookup of the authenticated sub on every request", async () => {
  const identity = { sub: "member", claims: { auth_time: 99 } };
  await expect(assertUserSession(identity, client)).resolves.toBeUndefined();
  send.mockResolvedValue({ Item: { userId: "member", disabled: true, revokedBefore: 100 } });
  await expect(assertUserSession(identity, client)).rejects.toMatchObject({ name: "Unauthorized", message: expect.stringContaining("inactive") });
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
  expect(send.mock.calls[0][0].input).toEqual({ TableName: "access-status", Key: { userId: "member" }, ConsistentRead: true });
});

it("requires fresh authentication after reactivation even if the revoked session refreshed to a new JWT", async () => {
  send.mockResolvedValue({ Item: { userId: "member", disabled: false, revokedBefore: 100 } });
  await expect(assertUserSession({ sub: "member", claims: { auth_time: 99, iat: 150 } }, client)).rejects.toThrow("Sign in again");
  await expect(assertUserSession({ sub: "member", claims: { auth_time: 100, iat: 150 } }, client)).rejects.toThrow("Sign in again");
  await expect(assertUserSession({ sub: "member", claims: { auth_time: 101, iat: 150 } }, client)).resolves.toBeUndefined();
  await expect(assertUserSession({ claims: { sub: "member", auth_time: 101 } }, client)).resolves.toBeUndefined();
});

it.each([undefined, "101", null, NaN, Infinity, 100.5])("rejects missing or malformed original authentication time after a revocation (%s)", async auth_time => {
  send.mockResolvedValue({ Item: { userId: "member", disabled: false, revokedBefore: 100 } });
  await expect(assertUserSession({ sub: "member", claims: { auth_time } }, client)).rejects.toThrow("Sign in again");
});

it("fails closed if status storage or its configuration is unavailable", async () => {
  send.mockRejectedValue(new Error("Storage unavailable"));
  await expect(assertUserSession({ sub: "member" }, client)).rejects.toThrow("Storage unavailable");
  delete process.env.USER_ACCESS_TABLE;
  await expect(readUserAccess("member", client)).rejects.toThrow("not configured");
});

it("rejects an anonymous session without any storage reads", async () => {
  await expect(assertUserSession(undefined, client)).rejects.toMatchObject({ name: "Unauthorized" });
  expect(send).not.toHaveBeenCalled();
});
