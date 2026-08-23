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
  GetCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
  TransactWriteCommand: class {
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
    .map(([cmd]) => cmd.input as Record<string, unknown>)
    .flatMap((input) => [
      ...(input.Item ? [input.Item as Record<string, unknown>] : []),
      ...((input.TransactItems as { Put?: { Item?: Record<string, unknown> } }[] | undefined) ?? [])
        .flatMap((t) => (t.Put?.Item ? [t.Put.Item] : [])),
    ]);

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
    // Enable order: the row lands BEFORE the flag — flag on implies logged.
    const kinds = sendMock.mock.calls
      .map(([cmd]) => cmd.input as Record<string, unknown>)
      .filter((i) => i.Item || i.UpdateExpression)
      .map((i) => (i.Item ? "log" : "flag"));
    expect(kinds).toEqual(["log", "flag"]);
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

  it("never flips the flag when the enable log cannot land", async () => {
    // Log-first: with the row unwritable, the flag is NEVER touched — the
    // stronger form of the old revert, with no window where a failed revert
    // could leave lending on unrecorded.
    const res = await run(true);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("NOT enabled");
    expect(flagWrites()).toEqual([]);
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

describe("a concurrent disable beats an in-flight enable", () => {
  it("enable's flag write is conditional, loses cleanly, and corrects only after verifying OFF", async () => {
    // Get returns a stamp; the conditional Update then rejects (the disable
    // moved the stamp). The loser VERIFIES the flag — strongly consistent —
    // sees it off, and only then writes the DISABLED correction row.
    sendMock.mockImplementation((cmd: { input: Record<string, unknown> }) => {
      if (!cmd.input.UpdateExpression && !cmd.input.Item) {
        expect(cmd.input.ConsistentRead).toBe(true);
        return Promise.resolve({ Item: { premiumFinanceEnabledAt: "2026-08-21T15:00:00.000Z" } });
      }
      if (cmd.input.ConditionExpression) {
        const e = new Error("stamp moved");
        (e as { name?: string }).name = "ConditionalCheckFailedException";
        return Promise.reject(e);
      }
      return Promise.resolve({});
    });
    const res = await run(true);
    expect(res.ok).toBe(false);
    // The one flag write attempted was the conditional one that lost.
    expect(flagWrites()).toEqual([true]);
    // ENABLED then its correction — stamped as a LATER event, so the
    // correction sorts after the row it corrects.
    const rows = logPuts();
    expect(rows.map((r) => r.outcome)).toEqual(["ENABLED", "DISABLED"]);
    expect(rows[1].reason).toContain("lost to a concurrent flip");
    expect(String(rows[1].occurredAt) > String(rows[0].occurredAt)).toBe(true);
    // And the correction rides a transaction conditioned on the flag still
    // being off with the stamp the verify saw — an enable landing in the
    // window cancels the whole thing instead of being contradicted.
    const txns = sendMock.mock.calls
      .map(([cmd]) => cmd.input as Record<string, unknown>)
      .filter((i) => i.TransactItems);
    expect(txns).toHaveLength(1);
    const items = txns[0].TransactItems as {
      Update?: { ConditionExpression?: string };
      Put?: { Item?: Record<string, unknown> };
    }[];
    expect(items[0].Update?.ConditionExpression).toContain("premiumFinanceEnabled = :off");
    expect(items[0].Update?.ConditionExpression).toContain("premiumFinanceEnabledAt = :seenOff");
    expect(items[1].Put?.Item?.outcome).toBe("DISABLED");
  });

  it("a correction cancelled by a mid-window enable converges instead of contradicting", async () => {
    // The transaction cancels because the flag turned ON between the verify
    // and the correction: no DISABLED row lands, and the caller is told the
    // truth — the module is enabled.
    let gets = 0;
    sendMock.mockImplementation((cmd: { input: Record<string, unknown> }) => {
      if (cmd.input.TransactItems) {
        const e = new Error("condition failed");
        (e as { name?: string }).name = "TransactionCanceledException";
        return Promise.reject(e);
      }
      if (!cmd.input.UpdateExpression && !cmd.input.Item) {
        gets++;
        // readStamp, verify (off), re-verify after the cancel (now ON).
        if (gets <= 2) return Promise.resolve({ Item: { premiumFinanceEnabledAt: "2026-08-21T15:00:00.000Z" } });
        return Promise.resolve({ Item: { premiumFinanceEnabled: true } });
      }
      if (cmd.input.ConditionExpression) {
        const e = new Error("stamp moved");
        (e as { name?: string }).name = "ConditionalCheckFailedException";
        return Promise.reject(e);
      }
      return Promise.resolve({});
    });
    const res = await run(true);
    expect(res).toMatchObject({ ok: true, enabled: true });
    // The DISABLED row rode ONLY the rejected transaction — nothing wrote
    // it standalone, so it never landed.
    const standalone = sendMock.mock.calls
      .map(([cmd]) => cmd.input as Record<string, unknown>)
      .filter((i) => i.Item)
      .map((i) => (i.Item as Record<string, unknown>).outcome);
    expect(standalone).toEqual(["ENABLED"]);
  });

  it("a losing enable whose winner was ALSO an enable writes no false correction", async () => {
    // Two admins enable at once. The loser's condition fails, but the
    // verify shows the module ON — the correct record is the ENABLED row
    // it already wrote, not a DISABLED row over a live flag.
    let gets = 0;
    sendMock.mockImplementation((cmd: { input: Record<string, unknown> }) => {
      if (!cmd.input.UpdateExpression && !cmd.input.Item) {
        gets++;
        return Promise.resolve(
          gets === 1
            ? { Item: { premiumFinanceEnabledAt: "2026-08-21T15:00:00.000Z" } }
            : { Item: { premiumFinanceEnabled: true } }
        );
      }
      if (cmd.input.ConditionExpression) {
        const e = new Error("stamp moved");
        (e as { name?: string }).name = "ConditionalCheckFailedException";
        return Promise.reject(e);
      }
      return Promise.resolve({});
    });
    const res = await run(true);
    expect(res).toMatchObject({ ok: true, enabled: true });
    expect(logPuts().map((r) => r.outcome)).toEqual(["ENABLED"]);
  });

  it("writes no correction at all when the flag state cannot be verified", async () => {
    // Flip failed AND the verify read failed: a DISABLED row here could be
    // the false record over an ON flag. Say so and write nothing.
    let gets = 0;
    sendMock.mockImplementation((cmd: { input: Record<string, unknown> }) => {
      if (!cmd.input.UpdateExpression && !cmd.input.Item) {
        gets++;
        if (gets === 1) return Promise.resolve({ Item: {} });
        return Promise.reject(new Error("region on fire"));
      }
      if (cmd.input.UpdateExpression) return Promise.reject(new Error("socket closed"));
      return Promise.resolve({});
    });
    const res = await run(true);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("couldn't be verified");
    expect(logPuts().map((r) => r.outcome)).toEqual(["ENABLED"]);
  });

  it("clamps the DISABLED row past a fresher stamp it overwrote", async () => {
    // The enable this disable ends was stamped by a clock a minute ahead.
    // The flag write returns the old stamp; the DISABLED row must sort
    // after it, or the log's latest row says lending is on forever.
    const future = new Date(Date.now() + 60_000).toISOString();
    sendMock.mockImplementation((cmd: { input: Record<string, unknown> }) => {
      if (cmd.input.UpdateExpression) {
        const vals = cmd.input.ExpressionAttributeValues as Record<string, unknown>;
        if (vals[":v"] === false) {
          return Promise.resolve({ Attributes: { premiumFinanceEnabledAt: future } });
        }
        // The floor bump: conditional on our own write standing.
        expect(cmd.input.ConditionExpression).toContain("premiumFinanceEnabled = :off");
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    const res = await run(false);
    expect(res).toMatchObject({ ok: true, enabled: false });
    const [row] = logPuts();
    expect(row.outcome).toBe("DISABLED");
    expect(String(row.occurredAt) > future).toBe(true);
  });

  it("clamps the ENABLED stamp past a fresher disable's — occurredAt is the log's ordering", async () => {
    // The disable that raced in ran on a clock a minute ahead. Unclamped,
    // this enable's row would sort BEFORE the DISABLED state it supersedes,
    // and the latest row would say off while lending is on.
    const future = new Date(Date.now() + 60_000).toISOString();
    sendMock.mockImplementation((cmd: { input: Record<string, unknown> }) => {
      if (!cmd.input.UpdateExpression && !cmd.input.Item) {
        return Promise.resolve({ Item: { premiumFinanceEnabledAt: future } });
      }
      return Promise.resolve({});
    });
    const res = await run(true);
    expect(res).toMatchObject({ ok: true, enabled: true });
    const [row] = logPuts();
    expect(String(row.occurredAt) > future).toBe(true);
  });

  it("disable's flag write carries no condition — off always wins", async () => {
    sendMock.mockResolvedValue({});
    await run(false);
    const flagCmds = sendMock.mock.calls
      .map(([cmd]) => cmd.input as Record<string, unknown>)
      .filter((i) => i.UpdateExpression);
    expect(flagCmds).toHaveLength(1);
    expect(flagCmds[0].ConditionExpression).toBeUndefined();
  });
});

describe("a lost response is not a lost write", () => {
  it("verifies the flag after a failed enable flip and stands by a landed one", async () => {
    // The flip Update rejects (network), but the follow-up Get shows the
    // write actually committed: the enable stands, and no DISABLED
    // correction row is written over a flag that is ON.
    let gets = 0;
    sendMock.mockImplementation((cmd: { input: Record<string, unknown> }) => {
      if (cmd.input.Item) return Promise.resolve({});
      if (cmd.input.UpdateExpression) return Promise.reject(new Error("socket closed"));
      gets++;
      return Promise.resolve(
        gets === 1 ? { Item: {} } : { Item: { premiumFinanceEnabled: true } }
      );
    });
    const res = await run(true);
    expect(res).toMatchObject({ ok: true, enabled: true });
    // Exactly one log row (ENABLED) and no correction row.
    expect(logPuts().length).toBe(1);
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
