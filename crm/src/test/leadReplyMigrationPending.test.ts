import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ cutoff: Date.parse("2026-11-01T19:30:00Z") as number | null,
  query: vi.fn(), update: vi.fn(), get: vi.fn(), issue: vi.fn(), resolve: vi.fn(), db: vi.fn(), model: vi.fn(), invoke: vi.fn(), queue: vi.fn(), producer: vi.fn() }));
vi.mock("../../amplify/functions/migration-pending", () => ({
  migrationPendingCutoff: () => h.cutoff,
  migrationPendingHeld: (r: { createdAt?: string }) => h.cutoff !== null && (!r.createdAt || !Number.isFinite(Date.parse(r.createdAt)) || Date.parse(r.createdAt) <= h.cutoff),
}));
vi.mock("aws-amplify", () => ({ Amplify: { configure: vi.fn() } }));
vi.mock("@aws-amplify/backend/function/runtime", () => ({ getAmplifyDataClientConfig: async () => ({ resourceConfig: {}, libraryOptions: {} }) }));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models: { LeadReply: { leadRepliesByStatusAndDueAt: h.query, update: h.update } } }) }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: h.model }; } }));
vi.mock("@aws-sdk/client-lambda", () => ({ LambdaClient: class { send = h.invoke; }, InvokeCommand: class {} }));
vi.mock("../../amplify/functions/communications/store", () => ({ get: h.get, issue: h.issue, db: { send: h.db } }));
vi.mock("../../amplify/functions/communications/routing", () => ({ resolveIssue: h.resolve }));
vi.mock("../../amplify/functions/communications/operations", () => ({ enqueueOperation: h.queue, assignedEmailProducer: h.producer }));
import { handler } from "../../amplify/functions/lead-reply/handler";
const old = { id: "old", accountId: "account", submissionId: "submission", status: "WAITING", dueAt: "2026-11-01T19:31:00Z", createdAt: "2026-10-29T12:00:00Z", updatedAt: "2026-11-01T19:34:00Z" };
const fresh = { ...old, id: "fresh", createdAt: "2026-11-01T19:31:00Z" };
function noBusinessEffects() { for (const fn of [h.update, h.get, h.issue, h.resolve, h.db, h.model, h.invoke, h.queue, h.producer]) expect(fn).not.toHaveBeenCalled(); }
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-01T20:00:00Z")); h.cutoff = Date.parse("2026-11-01T19:30:00Z");
  h.query.mockReset().mockResolvedValue({ data: [] }); h.get.mockReset().mockResolvedValue({ data: { state: "ACCEPTED", uid: "existing-provider-uid" } });
  h.update.mockResolvedValue({ data: {} }); h.resolve.mockResolvedValue(undefined);
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
  it("retains the source account's original index and legacy behavior", async () => {
    h.cutoff = null; h.query.mockImplementation(async ({ status }) => ({ data: status === "WAITING" ? [{ ...old, createdAt: undefined }] : [] }));
    await handler(); expect(h.query.mock.calls[0][0].dueAt).toEqual({ le: "2026-11-01T20:00:00.000Z" }); expect(h.query.mock.calls[0][1].limit).toBe(8);
    expect(h.update).toHaveBeenCalledExactlyOnceWith({ id: "old", status: "QUEUED" }); expect(h.queue).not.toHaveBeenCalled();
  });
});
