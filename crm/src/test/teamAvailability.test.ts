import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-cognito-identity-provider", () => ({
  CognitoIdentityProviderClient: class {
    send = h.send;
  },
  ListUsersCommand: class {
    constructor(public input: unknown) {}
  },
}));
import { availableTeamUsers } from "../../amplify/functions/communications/teamAvailability";

const user = (id: string, enabled = true) => ({
  Enabled: enabled,
  Attributes: [{ Name: "sub", Value: id }],
});
beforeEach(() => {
  h.send.mockReset();
  vi.stubEnv("USER_POOL_ID", "pool");
});
afterEach(() => vi.unstubAllEnvs());

describe("current teammate availability", () => {
  it("uses bounded pages, including empty pages, and excludes disabled/deleted users", async () => {
    h.send
      .mockResolvedValueOnce({
        Users: [user("enabled"), user("disabled", false), user("unrelated")],
        PaginationToken: "second",
      })
      .mockResolvedValueOnce({ Users: [], PaginationToken: "third" })
      .mockResolvedValueOnce({ Users: [user("later")] });
    expect(
      await availableTeamUsers(["enabled", "disabled", "deleted", "later"]),
    ).toEqual(new Set(["enabled", "later"]));
    expect(h.send.mock.calls.map(([command]) => command.input)).toEqual([
      { UserPoolId: "pool", Limit: 60, PaginationToken: undefined },
      { UserPoolId: "pool", Limit: 60, PaginationToken: "second" },
      { UserPoolId: "pool", Limit: 60, PaginationToken: "third" },
    ]);
  });
  it("stops once every requested identity is resolved without reading unrelated pages", async () => {
    h.send.mockResolvedValue({
      Users: [user("a"), user("b", false)],
      PaginationToken: "unneeded",
    });
    expect(await availableTeamUsers(["a", "b", "a"])).toEqual(new Set(["a"]));
    expect(h.send).toHaveBeenCalledTimes(1);
  });
  it("rejects a failed later page instead of returning a partial availability set", async () => {
    h.send
      .mockResolvedValueOnce({ Users: [user("a")], PaginationToken: "second" })
      .mockRejectedValueOnce(new Error("Cognito unavailable"));
    await expect(availableTeamUsers(["a", "b"])).rejects.toThrow(
      "Cognito unavailable",
    );
  });
  it("rejects repeated pagination cursors", async () => {
    h.send.mockResolvedValue({ Users: [], PaginationToken: "repeated" });
    await expect(availableTeamUsers(["missing"])).rejects.toThrow(
      "verify teammate availability",
    );
    expect(h.send).toHaveBeenCalledTimes(2);
  });
  it("fails a capped incomplete listing instead of hiding unvisited teammates", async () => {
    let page = 0;
    h.send.mockImplementation(async () => ({
      Users: [],
      PaginationToken: `next-${++page}`,
    }));
    await expect(availableTeamUsers(["missing"])).rejects.toThrow(
      "verify all teammates",
    );
    expect(h.send).toHaveBeenCalledTimes(100);
  });
});
