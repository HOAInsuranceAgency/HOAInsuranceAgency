import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GetCommand } from "@aws-sdk/lib-dynamodb";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/lib-dynamodb", async (original) => ({
  ...await original<typeof import("@aws-sdk/lib-dynamodb")>(),
  DynamoDBDocumentClient: { from: () => ({ send: mocks.send }) },
}));
import { readPaidContext } from "../../amplify/functions/stripe-webhook/lookups";

const invoice = { accountId: "account-1", policyId: "policy-1" };
let records: Record<string, Record<string, unknown>>;

beforeEach(() => {
  vi.stubEnv("ACCOUNT_TABLE", "Accounts");
  vi.stubEnv("POLICY_TABLE", "Policies");
  vi.stubEnv("CARRIER_TABLE", "Carriers");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  records = {
    "Accounts/account-1": { name: "Test HOA" },
    "Policies/policy-1": { policyNumber: "POL-1", carrierId: "carrier-1" },
    "Carriers/carrier-1": { name: "Test Carrier" },
  };
  mocks.send.mockReset().mockImplementation(async (command: GetCommand) => ({
    Item: records[`${command.input.TableName}/${command.input.Key?.id}`],
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("paid invoice context", () => {
  it("reads each related record once to resolve the remittance names", async () => {
    expect(await readPaidContext(invoice)).toEqual({
      associationName: "Test HOA", policyNumber: "POL-1", carrierName: "Test Carrier",
    });
    expect(mocks.send).toHaveBeenCalledTimes(3);
  });

  it("keeps the policy number and carrier from the same policy snapshot", async () => {
    let policyReads = 0;
    records["Carriers/carrier-2"] = { name: "Replacement Carrier" };
    mocks.send.mockImplementation(async (command: GetCommand) => {
      if (command.input.TableName === "Policies" && policyReads++ > 0) {
        return { Item: { policyNumber: "POL-2", carrierId: "carrier-2" } };
      }
      return { Item: records[`${command.input.TableName}/${command.input.Key?.id}`] };
    });
    expect(await readPaidContext(invoice)).toEqual({
      associationName: "Test HOA", policyNumber: "POL-1", carrierName: "Test Carrier",
    });
  });

  it("keeps valid display text and treats missing or non-text attributes as absent", async () => {
    records["Accounts/account-1"] = { name: "  Test HOA  " };
    records["Policies/policy-1"] = { policyNumber: 123, carrierId: " " };
    expect(await readPaidContext(invoice)).toEqual({
      associationName: "  Test HOA  ", policyNumber: null, carrierName: null,
    });
  });

  it("does not query absent identifiers or unconfigured tables", async () => {
    vi.stubEnv("POLICY_TABLE", "");
    expect(await readPaidContext({ accountId: null, policyId: "policy-1" })).toEqual({
      associationName: null, policyNumber: null, carrierName: null,
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("returns absent names for deleted records", async () => {
    records = {};
    expect(await readPaidContext(invoice)).toEqual({
      associationName: null, policyNumber: null, carrierName: null,
    });
  });

  it.each(["Accounts", "Policies", "Carriers"])("preserves available names when %s cannot be read", async (failedTable) => {
    mocks.send.mockImplementation(async (command: GetCommand) => {
      if (command.input.TableName === failedTable) throw new Error("Read unavailable");
      return { Item: records[`${command.input.TableName}/${command.input.Key?.id}`] };
    });
    expect(await readPaidContext(invoice)).toEqual({
      associationName: failedTable === "Accounts" ? null : "Test HOA",
      policyNumber: failedTable === "Policies" ? null : "POL-1",
      carrierName: failedTable === "Accounts" ? "Test Carrier" : null,
    });
  });
});
