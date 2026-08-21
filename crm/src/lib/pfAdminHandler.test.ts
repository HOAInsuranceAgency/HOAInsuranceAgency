import { beforeEach, describe, expect, it, vi } from "vitest";
import { PF_CONFIG_SHA256 } from "./premiumFinance/jurisdictions";

/**
 * The kill switch's two directions, exercised against a mocked table.
 *
 * The asymmetry is the whole design (decision amendment, 2026-08-21):
 * enabling lending without a log must not stand, so a failed log write
 * REVERTS an enable — off is the safe state. Disabling is the moment counsel
 * said stop, so a failed log write must NEVER restore the flag — the module
 * stays off and the failure is surfaced instead. A source assertion cannot
 * hold that; only running the handler can, so the DynamoDB layer is mocked
 * the way licenseAlertsHandler.test.ts mocks its AWS clients.
 */

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {},
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: sendMock }) },
  UpdateCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
  PutCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

const flagWrites = () =>
  sendMock.mock.calls
    .map(([cmd]) => cmd.input as Record<string, never>)
    .filter((input) => input.UpdateExpression)
    .map((input) => (input.ExpressionAttributeValues as Record<string, unknown>)[":v"]);

const logPuts = () =>
  sendMock.mock.calls
    .map(([cmd]) => cmd.input as Record<string, never>)
    .filter((input) => input.Item)
    .map((input) => input.Item as Record<string, unknown>);

async function run(enabled: boolean) {
  const { handler } = await import("../../amplify/functions/pf-admin/handler");
  return handler({
    arguments: { enabled },
    identity: { sub: "sub-1", claims: { email: "jake@getgim.com" } },
  });
}

beforeEach(() => {
  sendMock.mockReset();
  process.env.AGENCY_SETTINGS_TABLE = "AgencySettings-test";
  process.env.PF_COMPLIANCE_LOG_TABLE = "PfComplianceLog-test";
});

describe("the happy path", () => {
  it("flips, logs once, and stamps the ruleset hash on the row", async () => {
    sendMock.mockResolvedValue({});
    const res = await run(true);
    expect(res).toMatchObject({ ok: true, enabled: true });
    expect(flagWrites()).toEqual([true]);
    const [row] = logPuts();
    expect(row.rule).toBe("module-flag");
    expect(row.outcome).toBe("ENABLED");
    expect(row.actorName).toBe("jake@getgim.com");
    // The regulator's question: which signed ruleset governed this decision.
    expect(row.configSha256).toBe(PF_CONFIG_SHA256);
    expect(row.__typename).toBe("PfComplianceLog");
  });
});

describe("a log write that will not succeed", () => {
  beforeEach(() => {
    sendMock.mockImplementation((cmd: { input: Record<string, unknown> }) =>
      cmd.input.Item ? Promise.reject(new Error("throttled")) : Promise.resolve({})
    );
  });

  it("REVERTS an enable — lending never turns on unrecorded", async () => {
    const res = await run(true);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("NOT enabled");
    // Flag on, three log attempts, flag back off. Off is where it ends.
    expect(flagWrites()).toEqual([true, false]);
    expect(logPuts().length).toBe(3);
  });

  it("NEVER restores the flag on a disable — off always wins", async () => {
    const res = await run(false);
    // The flip stands: counsel said stop, and a DynamoDB hiccup on the audit
    // write must not turn lending back on at exactly that moment.
    expect(res.ok).toBe(true);
    expect(res.enabled).toBe(false);
    expect(res.warning).toContain("Record this flip manually");
    expect(flagWrites()).toEqual([false]);
    expect(logPuts().length).toBe(3);
  });
});

describe("refusals", () => {
  it("does nothing without a boolean", async () => {
    sendMock.mockResolvedValue({});
    const res = await import("../../amplify/functions/pf-admin/handler").then((m) =>
      m.handler({ arguments: {}, identity: { sub: "s" } })
    );
    expect(res.ok).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does nothing when the tables are unconfigured", async () => {
    delete process.env.PF_COMPLIANCE_LOG_TABLE;
    const res = await run(false);
    expect(res.ok).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
