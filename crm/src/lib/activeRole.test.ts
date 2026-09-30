import { beforeEach, describe, expect, it, vi } from "vitest";
const generated = vi.hoisted(() => vi.fn(() => ({ models: {} })));
vi.mock("aws-amplify/data", () => ({ generateClient: generated }));
import "./client";
import { activeRoleHeaders, clearActiveRole, restoreActiveRole, setActiveRole } from "./activeRole";

beforeEach(() => { sessionStorage.clear(); clearActiveRole(); });

describe("active role requests", () => {
  it("sends the current view on the shared data client, including subsequent switches", async () => {
    expect(generated).toHaveBeenCalledWith({ headers: activeRoleHeaders });
    const groups = ["PRODUCER", "ADMIN"];
    expect(restoreActiveRole("alice", groups)).toBe("ADMIN");
    expect(await activeRoleHeaders()).toEqual({ "x-crm-role": "ADMIN" });
    setActiveRole("alice", "PRODUCER", groups);
    expect(await activeRoleHeaders()).toEqual({ "x-crm-role": "PRODUCER" });
    clearActiveRole();
    expect(await activeRoleHeaders()).toEqual({});
  });

  it("keeps saved views per user and discards a role when it is no longer assigned", () => {
    setActiveRole("alice", "PRODUCER", ["ADMIN", "PRODUCER"]);
    expect(restoreActiveRole("bob", ["ADMIN", "PRODUCER"])).toBe("ADMIN");
    expect(restoreActiveRole("alice", ["ADMIN", "PRODUCER"])).toBe("PRODUCER");
    expect(restoreActiveRole("alice", ["ADMIN"])).toBe("ADMIN");
    expect(restoreActiveRole("alice", ["ADMIN", "PRODUCER"])).toBe("ADMIN");
  });

  it("rejects an unassigned role without changing request scope", async () => {
    restoreActiveRole("alice", ["PRODUCER"]);
    expect(() => setActiveRole("alice", "ADMIN", ["PRODUCER"])).toThrow("not assigned");
    expect(await activeRoleHeaders()).toEqual({ "x-crm-role": "PRODUCER" });
  });

  it("preserves ungrouped legacy users without claiming a group", async () => {
    setActiveRole("alice", "ADMIN", ["ADMIN"]);
    expect(restoreActiveRole("bob", [])).toBe("STAFF");
    expect(await activeRoleHeaders()).toEqual({});
  });
});
