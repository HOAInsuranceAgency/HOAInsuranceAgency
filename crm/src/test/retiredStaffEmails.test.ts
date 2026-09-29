import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ ses: vi.fn(), data: vi.fn(), storage: vi.fn(), front: vi.fn(), loans: [] as Record<string, unknown>[] }));
vi.mock("@aws-sdk/client-sesv2", () => ({ SESv2Client: class { send = h.ses; }, SendEmailCommand: class { constructor(public input: unknown) {} } }));
vi.mock("aws-amplify", () => ({ Amplify: { configure: vi.fn() } }));
vi.mock("aws-amplify/data", () => ({ generateClient: () => { h.data(); return { models: { PfLoan: { list: async () => ({ data: h.loans }) } } }; } }));
vi.mock("@aws-amplify/backend/function/runtime", () => ({ getAmplifyDataClientConfig: async () => ({ resourceConfig: {}, libraryOptions: {} }) }));
vi.mock("@aws-sdk/lib-dynamodb", async original => ({ ...await original<typeof import("@aws-sdk/lib-dynamodb")>(), DynamoDBDocumentClient: { from: () => ({ send: h.storage }) } }));
vi.mock("../../amplify/functions/communications/providers", async original => ({ ...await original<typeof import("../../amplify/functions/communications/providers")>(), front: h.front }));

beforeEach(() => {
  vi.clearAllMocks(); h.loans = []; h.storage.mockResolvedValue({});
  vi.useFakeTimers(); vi.setSystemTime("2026-09-29T13:00:00.000Z");
  // Even a warm invocation carrying the old production configuration is inert.
  for (const name of ["LICENSE_ALERT_FROM", "TASK_DIGEST_FROM", "OPS_ROLLUP_FROM", "OPS_ROLLUP_TO", "ACCOUNTING_MAILBOX", "AGENCY_MAILBOX"]) vi.stubEnv(name, "staff@example.com");
  vi.stubEnv("COMMUNICATION_TABLE", "comms"); vi.stubEnv("CRM_BASE_URL", "https://crm.example.test");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("retired daily staff emails", () => {
  it.each([
    ["license expiration digest", () => import("../../amplify/functions/license-alerts/handler")],
    ["outstanding task digest", () => import("../../amplify/functions/task-digest/handler")],
    ["owner operations rollup", () => import("../../amplify/functions/ops-rollup/handler")],
    ["daily communication report", () => import("../../amplify/functions/communications/reports")],
  ] as const)("never sends or mutates state for legacy %s invocations", async (_name, load) => {
    const { handler } = await load();
    for (const event of [undefined, { source: "aws.events", time: "2026-09-29T13:00:00Z" }, { retry: true, state: "READY", body: "Queued daily email", to: "staff@example.com" }]) {
      await expect(handler(event)).resolves.toEqual({ retired: true, sent: false });
    }
    expect(h.ses).not.toHaveBeenCalled(); expect(h.front).not.toHaveBeenCalled();
    expect(h.data).not.toHaveBeenCalled(); expect(h.storage).not.toHaveBeenCalled();
  });

  it("retains default detection and pending-payment compliance records without daily accounting emails", async () => {
    vi.stubEnv("PF_LOAN_TABLE", "loans"); vi.stubEnv("PF_COMPLIANCE_LOG_TABLE", "compliance");
    h.loans = [
      { id: "missed", accountId: "a1", state: "MA", status: "ACTIVE", nextDueAt: "2026-09-27" },
      { id: "clearing", accountId: "a2", state: "MA", status: "ACTIVE", nextDueAt: "2026-09-27", autopayPendingIntentId: "pi_recent", autopayAttemptedAt: "2026-09-28T13:00:00Z" },
      { id: "stale", accountId: "a3", state: "MA", status: "ACTIVE", nextDueAt: "2026-09-01", autopayPendingIntentId: "pi_stale", autopayAttemptedAt: "2026-09-01T13:00:00Z" },
    ];
    const { handler } = await import("../../amplify/functions/pf-default-sweep/handler"); await handler();
    const writes = h.storage.mock.calls.map(([command]) => command.input);
    expect(writes.filter(write => write.Key)).toEqual([expect.objectContaining({ TableName: "loans", Key: { id: "missed" },
      ConditionExpression: "#s = :active AND nextDueAt = :seen AND attribute_not_exists(autopayPendingIntentId)" })]);
    expect(writes.filter(write => write.Item).map(write => ({ account: write.Item.accountId, rule: write.Item.rule }))).toEqual([
      { account: "a3", rule: "autopay-attempt" }, { account: "a1", rule: "default-detected" },
    ]);
    expect(h.ses).not.toHaveBeenCalled(); expect(h.front).not.toHaveBeenCalled();
  });
});
