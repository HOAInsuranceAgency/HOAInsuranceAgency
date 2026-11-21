import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ enabledUser: vi.fn(), hasProducerRole: vi.fn() }));
vi.mock("../../amplify/functions/communications/workflow", () => ({
  enabledUser: h.enabledUser,
  hasProducerRole: h.hasProducerRole,
  UnavailableTeammateError: class extends Error {},
}));
import { UnavailableTeammateError } from "../../amplify/functions/communications/workflow";
import { currentTeamRoles } from "../../amplify/functions/communications/teamAvailability";

beforeEach(() => {
  h.enabledUser.mockReset();
  h.hasProducerRole.mockReset().mockResolvedValue(false);
});

describe("current teammate availability", () => {
  it("checks unique roster identities and separates available teammates from current producers", async () => {
    h.enabledUser.mockImplementation(async (id: string) => {
      if (["disabled", "deleted"].includes(id))
        throw new UnavailableTeammateError("Unavailable");
      return { Username: id };
    });
    h.hasProducerRole.mockImplementation(async (_id: string, user: { Username: string }) => user.Username === "enabled");
    expect(
      await currentTeamRoles([
        "enabled",
        "disabled",
        "deleted",
        "enabled",
        "another",
      ]),
    ).toEqual({ available: new Set(["enabled", "another"]), producers: new Set(["enabled"]) });
    expect(h.enabledUser.mock.calls.map(([id]) => id)).toEqual([
      "enabled",
      "disabled",
      "deleted",
      "another",
    ]);
    expect(h.hasProducerRole.mock.calls.map(([id]) => id)).toEqual(["enabled", "another"]);
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
    const result = currentTeamRoles(ids);
    expect(pending).toHaveLength(4);
    for (const end of [4, 8, 11]) {
      await vi.waitFor(() => expect(pending).toHaveLength(end));
      pending
        .slice(end - (end === 11 ? 3 : 4), end)
        .forEach((resolve) => resolve());
    }
    expect(await result).toEqual({ available: new Set(ids), producers: new Set() });
    expect(maxInFlight).toBe(4);
    expect(h.enabledUser).toHaveBeenCalledTimes(ids.length);
  });

  it.each(["availability", "producer role"])("settles the current batch after a %s lookup failure without starting more requests", async (lookup) => {
    const pending: (() => void)[] = [];
    const failingLookup = lookup === "availability" ? h.enabledUser : h.hasProducerRole;
    failingLookup.mockImplementation(async (id: string) => {
      if (id === "failed") throw new Error("Cognito unavailable");
      await new Promise<void>((resolve) => pending.push(resolve));
    });
    let settled = false;
    const result = currentTeamRoles(["failed", "a", "b", "c", "unstarted"]);
    const failed = expect(result).rejects.toThrow("Cognito unavailable");
    void result.catch(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    expect(settled).toBe(false);
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
