// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "aws-lambda";

const h = vi.hoisted(() => ({
  records: new Map<string, any>(), envelopes: [] as any[],
  get: vi.fn(), save: vi.fn(), issue: vi.fn(), resolveIssue: vi.fn(), config: vi.fn(),
}));
vi.mock("../../amplify/functions/communications/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../amplify/functions/communications/store")>(),
  get: h.get, save: h.save, issue: h.issue,
}));
vi.mock("../../amplify/functions/communications/config", () => ({ config: h.config }));
vi.mock("../../amplify/functions/communications/routing", () => ({ resolveIssue: h.resolveIssue }));
vi.mock("@sentry/aws-serverless", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sentry/aws-serverless")>();
  return { ...actual, init: (options: Parameters<typeof actual.init>[0]) => actual.init({
    ...options, transport: () => ({
      send: async (envelope) => { h.envelopes.push(envelope); return { statusCode: 200 }; },
      flush: async () => true,
    }),
  }) };
});

const START = Date.parse("2026-11-05T02:00:00.000Z");
const MESSAGE = "Communication processing requires intervention";
const HEALTH_MESSAGE = "Communication processing has stopped. Incoming work may be missing.";
const context = (): Context => ({
  callbackWaitsForEmptyEventLoop: true, functionName: "monitor", functionVersion: "$LATEST",
  invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:monitor", memoryLimitInMB: "512",
  awsRequestId: "synthetic", logGroupName: "synthetic", logStreamName: "synthetic",
  getRemainingTimeInMillis: () => 30_000, done: () => {}, fail: () => {}, succeed: () => {},
});
const events = () => h.envelopes.flatMap(envelope => envelope[1].filter((item: any) => item[0].type === "event").map((item: any) => item[1]));
const monitor = () => h.records.get("health:monitor");
function worker(lagging = true, at: unknown = new Date().toISOString()) {
  h.records.set("health:worker", { id: "health:worker", kind: "HEALTH", version: 1, data: { at, lagging } });
}
function advance(ms: number) { vi.setSystemTime(START + ms); worker(); }
async function invoke(): Promise<unknown> {
  const { handler } = await import("../../amplify/functions/communications/monitor");
  const { monitorHandler } = await import("../../amplify/functions/monitoring");
  return (monitorHandler(handler, "communications.monitor") as (...args: any[]) => Promise<unknown>)({}, context());
}
async function failing() {
  let failure: unknown;
  try { await invoke(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(MESSAGE);
  expect((failure as Error).name).toBe("Error");
  return failure as Error;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(START);
  vi.stubEnv("SENTRY_DSN", "https://public@example.com/1");
  vi.stubEnv("SENTRY_ENVIRONMENT", "test"); vi.stubEnv("SENTRY_RELEASE", "test-release");
  h.records.clear(); h.envelopes.length = 0;
  h.get.mockReset().mockImplementation(async (id: string) => h.records.get(id));
  h.save.mockReset().mockImplementation(async (record: any) => { h.records.set(record.id, record); return record; });
  h.issue.mockReset().mockResolvedValue(undefined); h.resolveIssue.mockReset().mockResolvedValue(undefined);
  h.config.mockReset().mockResolvedValue({ activatedAt: "2026-11-01T00:00:00.000Z" });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  worker();
});
afterEach(async () => {
  await (await import("@sentry/aws-serverless")).close(100);
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
});

describe("persistent communication health reporting", () => {
  it("forwards the first failure, suppresses only its persisted duplicate, and keeps throws/logs/type/stack", async () => {
    await failing();
    expect(events()).toHaveLength(1);
    const firstAt = monitor().data.sentryHealth.lastForwardedAt;
    advance(60_000);
    const duplicate = await failing();
    expect(events()).toHaveLength(1);
    expect(monitor().data.sentryHealth).toMatchObject({ version: 1, reasons: ["lagging"], lastForwardedAt: firstAt });
    expect(h.issue).toHaveBeenCalledTimes(2);
    expect(h.issue).toHaveBeenLastCalledWith("independent-monitor", HEALTH_MESSAGE);
    expect(console.log).toHaveBeenCalledTimes(2);
    expect(console.log).toHaveBeenLastCalledWith('{"communicationMonitorFailures":1}');
    expect(events()[0].exception.values[0]).toMatchObject({ type: "Error", mechanism: { handled: false } });
    expect(events()[0].exception.values[0].stacktrace.frames.some((frame: any) => frame.filename?.includes("communications/monitor.ts"))).toBe(true);
    expect(Object.keys(duplicate)).toEqual([]);
    expect(JSON.stringify(h.envelopes)).not.toMatch(/sentryHealth|lastForwardedAt|private-state/);
    expect(h.get.mock.calls.every(([id]) => ["health:worker", "health:monitor"].includes(id))).toBe(true);
    expect(h.save.mock.calls.every(([row]) => row.id === "health:monitor" && row.kind === "HEALTH")).toBe(true);
  });

  it("retains the exact hourly boundary and does not extend the reminder on duplicate retries", async () => {
    await failing(); const first = monitor().data.sentryHealth.lastForwardedAt;
    advance(3_599_999); await failing();
    expect(events()).toHaveLength(1); expect(monitor().data.sentryHealth.lastForwardedAt).toBe(first);
    advance(3_600_000); await failing();
    expect(events()).toHaveLength(2); expect(monitor().data.sentryHealth.lastForwardedAt).toBe(new Date().toISOString());
    advance(3_660_000); await failing(); expect(events()).toHaveLength(2);
  });

  it("forwards missing/stale/lagging reason changes and stable combinations", async () => {
    h.records.delete("health:worker"); await failing();
    expect(monitor().data.sentryHealth.reasons).toEqual(["missing"]);
    advance(60_000); worker(false, new Date(START - 600_000).toISOString()); await failing();
    expect(monitor().data.sentryHealth.reasons).toEqual(["stale"]);
    advance(120_000); await failing(); expect(monitor().data.sentryHealth.reasons).toEqual(["lagging"]);
    advance(180_000); worker(true, new Date(START - 600_000).toISOString()); await failing();
    expect(monitor().data.sentryHealth.reasons).toEqual(["stale", "lagging"]);
    advance(240_000); worker(true, new Date(START - 600_000).toISOString()); await failing();
    expect(events()).toHaveLength(4);
  });

  it("persists recovery and forwards the next same-reason incident", async () => {
    await failing(); advance(60_000); worker(false);
    await expect(invoke()).resolves.toEqual({ errors: [] });
    expect(monitor().data.sentryHealth).toMatchObject({ reasons: [], lastForwardedAt: null });
    expect(h.resolveIssue).toHaveBeenCalledWith("independent-monitor");
    expect(console.log).toHaveBeenLastCalledWith('{"communicationMonitorFailures":0}');
    advance(120_000); await failing(); expect(events()).toHaveLength(2);
  });

  it("uses persisted state across a cold start instead of process-memory suppression", async () => {
    await failing(); advance(60_000); await (await import("@sentry/aws-serverless")).close(100); vi.resetModules();
    await failing(); expect(events()).toHaveLength(1);
  });

  it.each([
    ["missing metadata", (row: any) => { delete row.data.sentryHealth; }],
    ["unknown version", (row: any) => { row.data.sentryHealth.version = 2; }],
    ["unknown reason", (row: any) => { row.data.sentryHealth.reasons = ["private-state"]; }],
    ["duplicate reasons", (row: any) => { row.data.sentryHealth.reasons = ["lagging", "lagging"]; }],
    ["noncanonical reasons", (row: any) => { row.data.sentryHealth.reasons = ["lagging", "stale"]; }],
    ["impossible missing combination", (row: any) => { row.data.sentryHealth.reasons = ["missing", "lagging"]; }],
    ["invalid timestamp", (row: any) => { row.data.sentryHealth.lastForwardedAt = "bad"; }],
    ["future timestamp", (row: any) => { row.data.sentryHealth.lastForwardedAt = new Date(START + 3_600_000).toISOString(); }],
    ["timestamp after observation", (row: any) => { row.data.sentryHealth.lastForwardedAt = new Date(START + 30_000).toISOString(); }],
    ["noncanonical timestamp", (row: any) => { row.data.sentryHealth.lastForwardedAt = "2026-11-05T02:00:00Z"; }],
    ["invalid observation timestamp", (row: any) => { row.data.at = "bad"; }],
    ["future observation timestamp", (row: any) => { row.data.at = new Date(START + 3_600_000).toISOString(); }],
    ["contradictory state", (row: any) => { row.data.errors = []; }],
  ])("fails open for %s", async (_label, corrupt) => {
    await failing(); corrupt(monitor()); advance(60_000); await failing(); expect(events()).toHaveLength(2);
  });

  it.each([undefined, "bad", "2026-11-05T02:00:00Z", "2026-11-05T04:00:00.000Z"])("never suppresses a known failure with untrusted worker time %s", async (at) => {
    await failing(); advance(60_000); worker(true, at); if (at === undefined) delete h.records.get("health:worker").data.at;
    await failing(); expect(events()).toHaveLength(2); expect(monitor().data.sentryHealth).toBeUndefined();
  });

  it("retains the original strict stale threshold", async () => {
    worker(false, new Date(START - 300_000).toISOString()); await expect(invoke()).resolves.toEqual({ errors: [] });
    vi.setSystemTime(START + 1); await failing(); expect(monitor().data.sentryHealth.reasons).toEqual(["stale"]);
  });

  it.each(["read", "write", "issue"])("fails open on operational %s failure, captures it separately and keeps the original health Error", async (operation) => {
    await failing(); advance(60_000);
    const failure = new Error("private-state-storage-failure"); failure.name = "OperationalStateError";
    if (operation === "read") h.get.mockImplementation(async (id: string) => { if (id === "health:monitor") throw failure; return h.records.get(id); });
    if (operation === "write") h.save.mockRejectedValueOnce(failure);
    if (operation === "issue") h.issue.mockRejectedValueOnce(failure);
    await failing();
    expect(events()).toHaveLength(3);
    expect(events().map(event => event.exception.values[0].type)).toEqual(["Error", "OperationalStateError", "Error"]);
    expect(console.log).toHaveBeenLastCalledWith('{"communicationMonitorFailures":1}');
    expect(JSON.stringify(h.envelopes)).not.toContain("private-state-storage-failure");
  });

  it("does not mark a duplicate when its conditional write loses a race", async () => {
    await failing(); advance(60_000);
    const conflict = new Error("conflict"); conflict.name = "ConditionalCheckFailedException";
    h.save.mockRejectedValueOnce(conflict); await failing();
    expect(events()).toHaveLength(3);
  });

  it("keeps the original health Error when persistence reporting itself throws", async () => {
    await failing(); advance(60_000);
    const sdk = await import("@sentry/aws-serverless");
    vi.spyOn(sdk, "captureException").mockImplementation(() => { throw new Error("reporter unavailable"); });
    h.save.mockRejectedValueOnce(new Error("storage unavailable"));
    await failing();
    // The SDK wrapper's internal capture still sees the original health Error.
    expect(events()).toHaveLength(2);
    expect(console.log).toHaveBeenLastCalledWith('{"communicationMonitorFailures":1}');
  });

  it("does not replace a healthy-path persistence error with a synthetic health error", async () => {
    worker(false); const failure = new Error("storage unavailable"); h.save.mockRejectedValueOnce(failure);
    await expect(invoke()).rejects.toBe(failure);
  });

  it("clears forwarding metadata when monitoring is disabled and captures after enabling", async () => {
    vi.stubEnv("SENTRY_DSN", ""); await failing(); expect(monitor().data.sentryHealth).toBeUndefined(); expect(events()).toHaveLength(0);
    vi.stubEnv("SENTRY_DSN", "https://public@example.com/1"); vi.resetModules(); advance(60_000);
    await failing(); expect(events()).toHaveLength(1);
  });

  it("does not authorize suppression with an invalid DSN", async () => {
    await failing();
    await (await import("@sentry/aws-serverless")).close(100);
    vi.stubEnv("SENTRY_DSN", "not-a-dsn"); vi.resetModules(); advance(60_000);
    await failing(); expect(monitor().data.sentryHealth).toBeUndefined();
    vi.stubEnv("SENTRY_DSN", "https://public@example.com/1"); vi.resetModules(); advance(120_000);
    await failing(); expect(events()).toHaveLength(2);
  });

  it.each(["dsn", "environment"])("forwards on %s destination cutover", async (setting) => {
    await failing(); const before = monitor().data.sentryHealth.target;
    await (await import("@sentry/aws-serverless")).close(100);
    if (setting === "dsn") vi.stubEnv("SENTRY_DSN", "https://another@example.com/2");
    else vi.stubEnv("SENTRY_ENVIRONMENT", "production");
    vi.resetModules(); advance(60_000); await failing();
    expect(events()).toHaveLength(2); expect(monitor().data.sentryHealth.target).not.toBe(before);
  });
});

describe("trusted duplicate Error identity through the real SDK", () => {
  it("drops only the marked object while rethrowing it; equal messages or spoofed properties still emit", async () => {
    const { monitorHandler, markRepeatedCommunicationHealthError } = await import("../../amplify/functions/monitoring");
    const marked = new Error(MESSAGE); markRepeatedCommunicationHealthError(marked);
    const run = (failure: Error) => (monitorHandler(async (_event: unknown, _context: Context) => { throw failure; }, "communications.monitor"))({}, context());
    await expect(run(marked)).rejects.toBe(marked); expect(events()).toHaveLength(0);
    const unmarked = Object.assign(new Error(MESSAGE), { repeatedCommunicationHealthError: true });
    await expect(run(unmarked)).rejects.toBe(unmarked); expect(events()).toHaveLength(1);
    const sdk = await import("@sentry/aws-serverless");
    sdk.captureEvent({ exception: { values: [{ type: "Error", value: MESSAGE }] }, tags: { function: "communications.monitor" } });
    await sdk.flush(100); expect(events()).toHaveLength(2);
    expect(JSON.stringify(h.envelopes)).not.toMatch(/repeatedCommunicationHealthError|lastForwardedAt|sentryHealth/);
  });
});
