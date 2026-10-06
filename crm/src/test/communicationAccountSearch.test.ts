import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../amplify/functions/communications/data", () => ({
  dataClient: async () => ({ models: { Account: { listAccountByStageAndName: h.query } } }),
}));
import { searchAccounts } from "../../amplify/functions/communications/accountSearch";

const actor = { actor: "alice", role: "PRODUCER" as const };
const rows = (count: number, name = "Cypress", prefix = "a") => Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, name: `${name} ${i}` }));
beforeEach(() => { h.query.mockReset(); h.query.mockResolvedValue({ data: [] }); });

describe("bounded communication account search", () => {
  it("finds mixed-case substrings in both stage partitions and only reads result fields", async () => {
    h.query.mockResolvedValueOnce({ data: [{ id: "a", name: "The CYPRESS Community" }, { id: "b", name: "Palm" }] })
      .mockResolvedValueOnce({ data: [{ id: "c", name: "cypress Townhomes" }], nextToken: null });
    expect(await searchAccounts({ query: "  CyPrEsS  " }, actor)).toEqual({ items: [
      { id: "a", name: "The CYPRESS Community" }, { id: "c", name: "cypress Townhomes" },
    ] });
    expect(h.query.mock.calls).toEqual([
      [{ stage: "LEAD" }, { limit: 25, nextToken: undefined, selectionSet: ["id", "name"] }],
      [{ stage: "CLIENT" }, { limit: 24, nextToken: undefined, selectionSet: ["id", "name"] }],
    ]);
  });

  it("bounds each segment to 100 evaluated rows and preserves continuation through empty matches", async () => {
    for (let i = 0; i < 4; i++) h.query.mockResolvedValueOnce({ data: rows(25, "Palm", `page${i}`), nextToken: `token${i}` });
    const first = await searchAccounts({ query: "cypress" }, actor);
    expect(first.items).toEqual([]); expect(first.nextToken).toEqual(expect.any(String));
    expect(h.query).toHaveBeenCalledTimes(4);
    expect(h.query.mock.calls.reduce((total, [, options]) => total + options.limit, 0)).toBe(100);
    h.query.mockResolvedValueOnce({ data: [{ id: "late", name: "Later Cypress" }] });
    expect(await searchAccounts({ query: "CYPRESS", nextToken: first.nextToken }, actor)).toEqual({ items: [{ id: "late", name: "Later Cypress" }] });
    expect(h.query.mock.calls[4]).toEqual([{ stage: "LEAD" }, { limit: 25, nextToken: "token3", selectionSet: ["id", "name"] }]);
  });

  it("never loses matching rows at the result boundary", async () => {
    h.query.mockResolvedValueOnce({ data: rows(24), nextToken: "after24" })
      .mockResolvedValueOnce({ data: [{ id: "a-24", name: "Cypress 24" }], nextToken: "after25" });
    const first = await searchAccounts({ query: "cypress" }, actor);
    expect(first.items).toHaveLength(25); expect(first.nextToken).toBeTruthy();
    expect(h.query.mock.calls[1][1].limit).toBe(1);
    h.query.mockResolvedValueOnce({ data: [{ id: "a-25", name: "Cypress 25" }] });
    const second = await searchAccounts({ query: "cypress", nextToken: first.nextToken }, actor);
    expect(second).toEqual({ items: [{ id: "a-25", name: "Cypress 25" }] });
    expect(h.query.mock.calls[2][1].nextToken).toBe("after25");
  });

  it("continues into CLIENT after a full terminal LEAD page", async () => {
    h.query.mockResolvedValueOnce({ data: rows(25) });
    const first = await searchAccounts({ query: "cypress" }, actor);
    expect(h.query).toHaveBeenCalledTimes(1);
    h.query.mockResolvedValueOnce({ data: [{ id: "client", name: "Cypress Client" }] });
    expect(await searchAccounts({ query: "cypress", nextToken: first.nextToken }, actor)).toEqual({ items: [{ id: "client", name: "Cypress Client" }] });
    expect(h.query.mock.calls[1][0]).toEqual({ stage: "CLIENT" });
  });

  it("keeps the unstarted CLIENT partition when the read budget expires at the stage boundary", async () => {
    for (let i = 0; i < 3; i++) h.query.mockResolvedValueOnce({ data: [], nextToken: `lead-${i}` });
    h.query.mockResolvedValueOnce({ data: [] });
    const first = await searchAccounts({ query: "cypress" }, actor);
    expect(first.items).toEqual([]); expect(first.nextToken).toBeTruthy();
    expect(h.query).toHaveBeenCalledTimes(4);
    h.query.mockResolvedValueOnce({ data: [{ id: "client", name: "Cypress Client" }] });
    expect(await searchAccounts({ query: "cypress", nextToken: first.nextToken }, actor)).toEqual({ items: [{ id: "client", name: "Cypress Client" }] });
    expect(h.query.mock.calls[4]).toEqual([{ stage: "CLIENT" }, { limit: 25, nextToken: undefined, selectionSet: ["id", "name"] }]);
  });

  it("deduplicates index candidates without overflowing or losing the continuation", async () => {
    const duplicate = { id: "a-0", name: "Cypress 0" };
    h.query.mockResolvedValueOnce({ data: [duplicate, duplicate], nextToken: "lead-next" })
      .mockResolvedValueOnce({ data: rows(24, "Cypress", "later"), nextToken: "remaining" });
    const result = await searchAccounts({ query: "cypress" }, actor);
    expect(result.items).toHaveLength(25);
    expect(new Set(result.items.map(item => item.id)).size).toBe(25);
    expect(result.nextToken).toBeTruthy();
    expect(h.query.mock.calls[1][1].limit).toBe(24);
  });

  it("preserves service cursors even when their pages contain no data", async () => {
    for (let i = 0; i < 4; i++) h.query.mockResolvedValueOnce({ data: [], nextToken: `empty-${i}` });
    const first = await searchAccounts({ query: "cypress" }, actor);
    expect(first.items).toEqual([]); expect(first.nextToken).toBeTruthy();
    const second = await searchAccounts({ query: "cypress", nextToken: first.nextToken }, actor);
    expect(h.query.mock.calls[4][1].nextToken).toBe("empty-3");
    expect(second).toEqual({ items: [] });
  });

  it("binds pagination to the normalized query, signed actor, and active role", async () => {
    h.query.mockResolvedValueOnce({ data: rows(25), nextToken: "next" });
    const { nextToken } = await searchAccounts({ query: "cypress" }, actor);
    h.query.mockClear();
    for (const [input, identity] of [
      [{ query: "palm", nextToken }, actor],
      [{ query: "cypress", nextToken }, { ...actor, actor: "bob" }],
      [{ query: "cypress", nextToken }, { ...actor, role: "ADMIN" as const }],
    ] as const) await expect(searchAccounts(input, identity)).rejects.toThrow("Start the search again");
    expect(h.query).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 12, "", "   ", "x".repeat(201)])("rejects invalid query %s before a read", async query => {
    await expect(searchAccounts({ query }, actor)).rejects.toThrow("1 to 200");
    expect(h.query).not.toHaveBeenCalled();
  });

  it.each(["", "not-json", "!bad!", "x".repeat(24001), Buffer.from(JSON.stringify({ version: 1, scope: "wrong", stage: 0 })).toString("base64url")])("rejects malformed cursor before a read", async nextToken => {
    await expect(searchAccounts({ query: "cypress", nextToken }, actor)).rejects.toThrow("Start the search again");
    expect(h.query).not.toHaveBeenCalled();
  });

  it("fails the segment if any indexed page errors rather than returning partial or empty results", async () => {
    h.query.mockResolvedValueOnce({ data: [{ id: "a", name: "Cypress" }], nextToken: "later" })
      .mockResolvedValueOnce({ data: [], errors: [{ message: "Unauthorized" }] });
    await expect(searchAccounts({ query: "cypress" }, actor)).rejects.toThrow("Could not search accounts");
  });

  it("rejects non-advancing cursors and malformed pages", async () => {
    h.query.mockResolvedValueOnce({ data: [], nextToken: "same" }).mockResolvedValueOnce({ data: [], nextToken: "same" });
    await expect(searchAccounts({ query: "cypress" }, actor)).rejects.toThrow("did not advance");
    for (const page of [{ data: rows(26) }, { data: [{ id: "a", name: null }] }, { data: null }, { data: [], nextToken: 12 }]) {
      h.query.mockResolvedValueOnce(page);
      await expect(searchAccounts({ query: "cypress" }, actor)).rejects.toThrow("Could not search accounts");
    }
  });
});
