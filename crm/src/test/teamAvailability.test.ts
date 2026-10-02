import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ enabledUser: vi.fn() }));
vi.mock("../../amplify/functions/communications/workflow", () => ({
  enabledUser: h.enabledUser,
  UnavailableTeammateError: class extends Error {},
}));
import { UnavailableTeammateError } from "../../amplify/functions/communications/workflow";
import { availableTeamUsers } from "../../amplify/functions/communications/teamAvailability";

beforeEach(() => { h.enabledUser.mockReset(); });

describe("current teammate availability", () => {
  it("checks only unique roster identities and treats disabled/deleted users as unavailable", async () => {
    h.enabledUser.mockImplementation(async (id: string) => {
      if (["disabled", "deleted"].includes(id))
        throw new UnavailableTeammateError("Unavailable");
    });
    expect(
      await availableTeamUsers([
        "enabled",
        "disabled",
        "deleted",
        "enabled",
        "another",
      ]),
    ).toEqual(new Set(["enabled", "another"]));
    expect(h.enabledUser.mock.calls.map(([id]) => id)).toEqual([
      "enabled",
      "disabled",
      "deleted",
      "another",
    ]);
  });

  it("bounds concurrent requests while visiting the entire roster", async () => {
    const pending: (() => void)[] = [];
    let inFlight = 0,
      maxInFlight = 0;
    h.enabledUser.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => pending.push(resolve));
      inFlight--;
    });
    const ids = Array.from({ length: 11 }, (_, index) => `member-${index}`);
    const result = availableTeamUsers(ids);
    expect(pending).toHaveLength(4);
    for (const end of [4, 8, 11]) {
      await vi.waitFor(() => expect(pending).toHaveLength(end));
      pending
        .slice(end - (end === 11 ? 3 : 4), end)
        .forEach((resolve) => resolve());
    }
    expect(await result).toEqual(new Set(ids));
    expect(maxInFlight).toBe(4);
    expect(h.enabledUser).toHaveBeenCalledTimes(ids.length);
  });

  it("settles the current batch and propagates a lookup failure without starting more requests", async () => {
    const pending: (() => void)[] = [];
    h.enabledUser.mockImplementation(async (id: string) => {
      if (id === "failed") throw new Error("Cognito unavailable");
      await new Promise<void>((resolve) => pending.push(resolve));
    });
    let settled = false;
    const result = availableTeamUsers(["failed", "a", "b", "c", "unstarted"]);
    const failed = expect(result).rejects.toThrow("Cognito unavailable");
    void result.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(pending).toHaveLength(3);
    pending.forEach((resolve) => resolve());
    await failed;
    expect(h.enabledUser.mock.calls.map(([id]) => id)).toEqual([
      "failed",
      "a",
      "b",
      "c",
    ]);
  });
});
