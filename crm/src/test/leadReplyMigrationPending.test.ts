import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ cutoff: Date.parse("2026-11-01T19:30:00Z") as number | null,
  query: vi.fn(), update: vi.fn(), get: vi.fn(), issue: vi.fn(), resolve: vi.fn(), db: vi.fn(), model: vi.fn(), invoke: vi.fn(), queue: vi.fn(), producer: vi.fn(),
  account: vi.fn(), documents: vi.fn(), contacts: vi.fn(), cursors: new Map<string, {nextToken?: string; through?: string; seenIds?: string[]}>() }));
vi.mock("../../amplify/functions/migration-pending", () => ({
  migrationPendingCutoff: () => h.cutoff,
  migrationPendingHeld: (r: { createdAt?: string }) => h.cutoff !== null && (!r.createdAt || !Number.isFinite(Date.parse(r.createdAt)) || Date.parse(r.createdAt) <= h.cutoff),
}));
vi.mock("aws-amplify", () => ({ Amplify: { configure: vi.fn() } }));
vi.mock("@aws-amplify/backend/function/runtime", () => ({ getAmplifyDataClientConfig: async () => ({ resourceConfig: {}, libraryOptions: {} }) }));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models: { LeadReply: { leadRepliesByStatusAndDueAt: h.query, update: h.update },
  Account: { get: h.account }, Document: { list: h.documents }, Contact: { list: h.contacts } } }) }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: h.model }; } }));
vi.mock("@aws-sdk/client-lambda", () => ({ LambdaClient: class { send = h.invoke; }, InvokeCommand: class {} }));
vi.mock("../../amplify/functions/communications/store", () => ({ get: h.get, issue: h.issue, db: { send: h.db } }));
vi.mock("../../amplify/functions/communications/queueCursor", () => ({
  openQueueCursor: async (id: string, now: string) => ({ id, nextToken: h.cursors.get(id)?.nextToken, through: h.cursors.get(id)?.through ?? now, seenIds: h.cursors.get(id)?.seenIds ?? [] }),
  saveQueueCursor: async (cursor: {id: string; through: string}, nextToken?: string, seenIds: string[] = []) => h.cursors.set(cursor.id, { nextToken, through: nextToken || seenIds.length ? cursor.through : undefined, seenIds }),
}));
vi.mock("../../amplify/functions/communications/routing", () => ({ resolveIssue: h.resolve }));
vi.mock("../../amplify/functions/communications/operations", () => ({ enqueueOperation: h.queue, assignedEmailProducer: h.producer }));
import { handler } from "../../amplify/functions/lead-reply/handler";
const old = { id: "old", accountId: "account", submissionId: "submission", status: "WAITING", dueAt: "2026-11-01T19:31:00Z", createdAt: "2026-10-29T12:00:00Z", updatedAt: "2026-11-01T19:34:00Z" };
const fresh = { ...old, id: "fresh", createdAt: "2026-11-01T19:31:00Z" };
function noBusinessEffects() { for (const fn of [h.update, h.get, h.issue, h.resolve, h.db, h.model, h.invoke, h.queue, h.producer]) expect(fn).not.toHaveBeenCalled(); }
beforeEach(() => {
  vi.clearAllMocks(); h.cursors.clear(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-01T20:00:00Z")); h.cutoff = Date.parse("2026-11-01T19:30:00Z");
  h.query.mockReset().mockResolvedValue({ data: [] }); h.get.mockReset().mockResolvedValue({ data: { state: "ACCEPTED", uid: "existing-provider-uid" } });
  h.update.mockResolvedValue({ data: {} }); h.resolve.mockResolvedValue(undefined);
  h.account.mockResolvedValue({ data: { id: "account" } }); h.documents.mockResolvedValue({ data: [{ name: "policy.pdf", ocrStatus: "PENDING" }] }); h.contacts.mockResolvedValue({ data: [] });
});
afterEach(() => vi.useRealTimers());
describe("migrated LeadReply inherited-work hold", () => {
  it("does not query or process any work in a closed preview without a final cutoff", async () => {
    h.cutoff = Infinity; const result = await handler(); expect(result.queued).toBe(0); expect(h.query).not.toHaveBeenCalled(); noBusinessEffects();
  });
  it("leaves old waiting rows unchanged even after a fresh updatedAt", async () => {
    h.query.mockImplementation(async ({ status }) => ({ data: status === "WAITING" ? [old] : [] }));
    await handler(); noBusinessEffects();
    expect(h.query.mock.calls[0][0].dueAt).toEqual({ between: ["2026-11-01T19:30:00.000Z", "2026-11-01T20:00:00.000Z"] });
  });
  it("does not recover or rewrite an inherited stalled send", async () => {
    h.query.mockImplementation(async ({ status }) => ({ data: status === "SENDING" ? [{ ...old, status, frontGenerationClaimedAt: "2026-10-29T12:01:00Z" }] : [] }));
    await handler(); noBusinessEffects();
  });
  it.each([undefined, "invalid", "2026-11-01T19:30:00Z"])("holds missing/malformed/boundary createdAt %s", async createdAt => {
    h.query.mockImplementation(async ({ status }) => ({ data: status === "WAITING" ? [{ ...old, createdAt }] : [] }));
    await handler(); noBusinessEffects();
  });
  it("pages past more than eight held rows to eligible new work", async () => {
    h.query.mockImplementation(async ({ status }, opts) => status !== "WAITING" ? { data: [] } : !opts.nextToken ? { data: Array.from({ length: 100 }, (_, i) => ({ ...old, id: `old-${i}` })), nextToken: "next" } : { data: [fresh] });
    const result = await handler(); expect(result.waiting).toBe(1); expect(h.get).toHaveBeenCalledExactlyOnceWith("op:ai:fresh");
    expect(h.update).toHaveBeenCalledExactlyOnceWith({ id: "fresh", status: "QUEUED" }); expect(h.queue).not.toHaveBeenCalled(); expect(h.model).not.toHaveBeenCalled();
  });
  it("caps historical scanning without touching a held row", async () => {
    h.query.mockImplementation(async ({ status }, opts) => status === "WAITING" ? { data: [old], nextToken: (opts.nextToken ?? "") + "x" } : { data: [] });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await handler(); expect(h.query.mock.calls.filter(([q]) => q.status === "WAITING")).toHaveLength(25); noBusinessEffects(); expect(warning).toHaveBeenCalled(); warning.mockRestore();
  });
  it("resumes beyond 2500 held candidates and does not skip fresh rows left in that page", async () => {
    const updated = new Set<string>();
    const newRows = Array.from({ length: 11 }, (_, i) => ({ ...fresh, id: `fresh-${i}` }));
    h.update.mockImplementation(async (r) => { updated.add(r.id); return { data: r }; });
    h.query.mockImplementation(async ({ status }, opts) => {
      if (status !== "WAITING") return { data: [] };
      const page = Number((opts.nextToken ?? "page-0").slice(5));
      if (page < 25) return { data: Array.from({ length: 100 }, (_, i) => ({ ...old, id: `held-${page * 100 + i}` })), nextToken: `page-${page + 1}` };
      return { data: newRows.filter(r => !updated.has(r.id)) };
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await handler()).waiting).toBe(0); expect(updated.size).toBe(0);
    vi.setSystemTime(new Date("2026-11-01T20:01:00Z")); h.query.mockClear();
    expect((await handler()).waiting).toBe(8);
    expect(h.query.mock.calls[0][1].nextToken).toBe("page-25");
    expect(h.query.mock.calls[0][0].dueAt.between[1]).toBe("2026-11-01T20:00:00.000Z");
    expect((await handler()).waiting).toBe(3);
    expect(h.cursors.get("lead-reply:WAITING")?.seenIds).toEqual(newRows.slice(8).map(r => r.id));
    expect([...updated].sort()).toEqual(newRows.map(r => r.id).sort());
    expect(h.queue).not.toHaveBeenCalled(); expect(h.model).not.toHaveBeenCalled(); warning.mockRestore();
  });
  it.each([1, 11])("advances beyond %s unchanged OCR waits to a later ready page, then revisits waits next sweep", async count => {
    const waitingRows = Array.from({ length: count }, (_, i) => ({ ...fresh, id: `ocr-${i}`, uploadCount: 1 }));
    const held = Array.from({ length: 100 - count }, (_, i) => ({ ...old, id: `held-${i}` }));
    const ready = { ...fresh, id: "ready-after-ocr" }; let completed = false;
    h.get.mockImplementation(async id => id.startsWith("op:ai:ocr-") ? undefined
      : id === "workflow:account" ? { data: { disposition: "ACTIVE", humanTakeover: false, salespersonId: "salesperson" } }
      : id === "op:ai:ready-after-ocr" ? { data: { state: "ACCEPTED", uid: "already-accepted" } } : { data: {} });
    h.update.mockImplementation(async r => { if (r.id === ready.id) completed = true; return { data: r }; });
    h.query.mockImplementation(async ({ status }, opts) => status !== "WAITING" ? { data: [] }
      : !opts.nextToken ? { data: [...held, ...waitingRows], nextToken: "after-ocr-page" }
      : { data: completed ? [] : [ready] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await handler()).waiting).toBe(Math.min(count, 8));
    expect(h.update).not.toHaveBeenCalled(); expect(h.documents).toHaveBeenCalledTimes(Math.min(count, 8));
    const firstCheckpoint = h.cursors.get("lead-reply:WAITING");
    vi.setSystemTime(new Date("2026-11-01T20:01:00Z"));
    if (count > 8) {
      expect((await handler()).waiting).toBe(3); expect(h.update).not.toHaveBeenCalled();
      expect(h.cursors.get("lead-reply:WAITING")?.seenIds).toHaveLength(11);
    }
    expect((await handler()).waiting).toBe(1);
    expect(h.update).toHaveBeenCalledExactlyOnceWith({ id: ready.id, status: "QUEUED" });
    expect(firstCheckpoint).toMatchObject({ nextToken: undefined, through: "2026-11-01T20:00:00.000Z", seenIds: waitingRows.slice(0, 8).map(r => r.id) });
    expect(h.query.mock.calls.filter(([query]) => query.status === "WAITING").every(([query]) => query.dueAt.between[1] === "2026-11-01T20:00:00.000Z")).toBe(true);
    expect((await handler()).waiting).toBe(0); // End of the finite sweep clears the cursor.
    const previousOcrChecks = h.documents.mock.calls.length;
    expect((await handler()).waiting).toBe(Math.min(count, 8));
    expect(h.documents).toHaveBeenCalledTimes(previousOcrChecks + Math.min(count, 8));
    expect(h.update.mock.calls.every(([r]) => r.id === ready.id)).toBe(true);
    expect(h.queue).not.toHaveBeenCalled(); expect(h.model).not.toHaveBeenCalled(); expect(h.invoke).not.toHaveBeenCalled();
    log.mockRestore();
  });
  it("retains the source account's original index and legacy behavior", async () => {
    h.cutoff = null; h.query.mockImplementation(async ({ status }) => ({ data: status === "WAITING" ? [{ ...old, createdAt: undefined }] : [] }));
    await handler(); expect(h.query.mock.calls[0][0].dueAt).toEqual({ le: "2026-11-01T20:00:00.000Z" }); expect(h.query.mock.calls[0][1].limit).toBe(8);
    expect(h.update).toHaveBeenCalledExactlyOnceWith({ id: "old", status: "QUEUED" }); expect(h.queue).not.toHaveBeenCalled();
  });
});
