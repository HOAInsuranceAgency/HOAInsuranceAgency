import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ send: vi.fn(), originate: vi.fn(), loans: vi.fn() }));
vi.mock("../../amplify/functions/data-client", () => ({ createDataClientGetter: () => vi.fn() }));
vi.mock("../../amplify/functions/pfOrigination", () => ({ originateLoan: h.originate }));
vi.mock("@aws-sdk/lib-dynamodb", async load => ({
  ...await load<typeof import("@aws-sdk/lib-dynamodb")>(),
  DynamoDBDocumentClient: { from: () => ({ send: h.send }) },
}));
import { financeOffer } from "../../amplify/functions/send-invoice/handler";

const currentLoan = () => ({
  id: "old-loan", status: "QUOTED", state: "MA", premium: 10_000, effectiveDate: "2026-11-07",
  apr: 14, downPct: 25, downPayment: 2500, payment: 730, months: 11, originationFee: 10,
  electionToken: "existing-token", electionTokenExpiresAt: "2026-12-01T00:00:00Z",
});
const account = (state: string) => ({ id: "account-1", state, type: "ASSOCIATION", incorporated: true });
const anchor = { kind: "policy" as const, id: "policy-1", lines: ["Commercial Property"], coverageEffectiveDate: "2026-11-01" };
const client = { models: {
  AgencySettings: { get: async () => ({ data: { premiumFinanceEnabled: true } }) },
  PfLoan: { list: h.loans },
} };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
  vi.stubEnv("PF_LOAN_TABLE", "loans");
  vi.stubEnv("PF_COMPLIANCE_LOG_TABLE", "compliance");
  vi.stubEnv("SITE_URL", "https://example.test");
  h.loans.mockResolvedValue({ data: [currentLoan()] });
  h.originate.mockResolvedValue({ ok: true, loanId: "new-loan", blocks: [] });
  h.send.mockImplementation(async command => command.constructor.name === "GetCommand"
    ? { Item: { ...currentLoan(), id: "new-loan", state: "FL", apr: 17.7 } }
    : {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("state changes on standing finance offers", () => {
  it("keeps a same-state frozen rate when the state changes only spelling", async () => {
    const result = await financeOffer(client as never, account(" Massachusetts "), anchor, 10_000, "board@example.test");
    expect(result).toMatchObject({ apr: 14, url: "https://example.test/finance/?t=existing-token" });
    expect(h.originate).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("replaces an uncommitted same-day offer when the account moves to another state", async () => {
    const result = await financeOffer(client as never, account("Florida"), anchor, 10_000, "board@example.test");
    expect(result?.apr).toBe(17.7);
    expect(h.originate).toHaveBeenCalledWith(expect.anything(), expect.anything(), true, expect.objectContaining({
      account: expect.objectContaining({ state: "Florida" }), anchor,
    }));
    const cancellation = h.send.mock.calls.map(([command]) => command).find(command => command.constructor.name === "UpdateCommand");
    expect(cancellation.input.ConditionExpression).toContain("attribute_not_exists(downPaymentIntentId)");
    expect(cancellation.input.ConditionExpression).toContain("attribute_not_exists(agreementSignedAt)");
    expect(cancellation.input.ConditionExpression).toContain("attribute_not_exists(electedAt)");
    expect(cancellation.input.ExpressionAttributeValues[":seen"]).toBe(10_000);
    const audit = h.send.mock.calls.map(([command]) => command).find(command => command.constructor.name === "PutCommand").input.Item;
    expect(JSON.parse(audit.inputs)).toMatchObject({ wasState: "MA", nowState: "Florida" });
  });

  it.each([
    { agreementSignedAt: "2026-11-07T11:00:00Z" },
    { electedAt: "2026-11-07T11:00:00Z" },
    { downPaymentIntentId: "clearing-payment" },
    { electionCheckoutUrl: "https://checkout.stripe.com/committed", electionCheckoutExpiresAt: "2026-11-08T12:00:00Z" },
  ])("suppresses a changed-state offer without changing a committed election", async commitment => {
    h.loans.mockResolvedValue({ data: [{ ...currentLoan(), ...commitment }] });
    expect(await financeOffer(client as never, account("FL"), anchor, 10_000, "board@example.test")).toBeNull();
    expect(h.originate).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("preserves a signed stale offer's frozen terms before payment setup", async () => {
    h.loans.mockResolvedValue({ data: [{ ...currentLoan(), effectiveDate: "2026-11-01", agreementSignedAt: "2026-11-01T11:00:00Z" }] });
    expect(await financeOffer(client as never, account("MA"), anchor, 10_000, "board@example.test")).toMatchObject({ apr: 14 });
    expect(h.originate).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("supersedes an unsigned quote when a known coverage date changes", async () => {
    h.loans.mockResolvedValue({ data: [{ ...currentLoan(), state: "DE", coverageEffectiveDate: "2026-11-01" }] });
    const changed = { ...anchor, coverageEffectiveDate: "2027-01-01" };
    await financeOffer(client as never, account("DE"), changed, 10_000, "board@example.test");
    expect(h.originate).toHaveBeenCalledWith(expect.anything(), expect.anything(), true, expect.objectContaining({ anchor: changed }));
    expect(h.send.mock.calls.some(([command]) => command.constructor.name === "UpdateCommand")).toBe(true);
  });

  it("suppresses changed coverage dates once the quote is signed", async () => {
    h.loans.mockResolvedValue({ data: [{ ...currentLoan(), state: "DE", coverageEffectiveDate: "2026-11-01", agreementSignedAt: "2026-11-07T11:00:00Z" }] });
    expect(await financeOffer(client as never, account("DE"), { ...anchor, coverageEffectiveDate: "2027-01-01" }, 10_000, "board@example.test")).toBeNull();
    expect(h.originate).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it.each(["MS", "SC", "NV"])("omits an unsigned stored offer in held %s without changing its row", async state => {
    h.loans.mockResolvedValue({ data: [{ ...currentLoan(), state }] });
    expect(await financeOffer(client as never, account(state), anchor, 10_000, "board@example.test")).toBeNull();
    expect(h.originate).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("still delegates a fresh held-state decision to the core for its compliance log", async () => {
    h.loans.mockResolvedValue({ data: [] });
    h.originate.mockResolvedValue({ ok: true, loanId: null, blocks: [{ rule: "jurisdiction-gate", reason: "Held" }] });
    expect(await financeOffer(client as never, account("MS"), anchor, 10_000, "board@example.test")).toBeNull();
    expect(h.originate).toHaveBeenCalledTimes(1);
  });

  it("does not reoffer an unsigned Iowa quote after the local month loses its published ceiling", async () => {
    const saved = { ...currentLoan(), state: "IA", apr: 6.5, effectiveDate: "2027-01-01", electionTokenExpiresAt: "2027-02-01T00:00:00Z" };
    h.loans.mockResolvedValue({ data: [saved] });
    vi.setSystemTime(new Date("2027-01-01T00:30:00Z"));
    expect(await financeOffer(client as never, account("IA"), anchor, 10_000, "board@example.test")).toMatchObject({ apr: 6.5 });
    vi.setSystemTime(new Date("2027-01-01T06:30:00Z"));
    expect(await financeOffer(client as never, account("IA"), anchor, 10_000, "board@example.test")).toBeNull();
    expect(h.originate).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("supersedes an unsigned legacy Michigan rate above the current limit", async () => {
    h.loans.mockResolvedValue({ data: [{ ...currentLoan(), state: "MI" }] });
    await financeOffer(client as never, account("MI"), anchor, 10_000, "board@example.test");
    expect(h.originate).toHaveBeenCalledWith(expect.anything(), expect.anything(), true, expect.objectContaining({ account: expect.objectContaining({ state: "MI" }) }));
    expect(h.send.mock.calls.some(([command]) => command.constructor.name === "UpdateCommand")).toBe(true);
  });

  it("does not reprice signed Michigan terms when the rate rule changes", async () => {
    h.loans.mockResolvedValue({ data: [{ ...currentLoan(), state: "MI", agreementSignedAt: "2026-11-07T11:00:00Z" }] });
    expect(await financeOffer(client as never, account("MI"), anchor, 10_000, "board@example.test")).toMatchObject({ apr: 14 });
    expect(h.originate).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("does not originate if a commitment wins the conditional cancellation race", async () => {
    h.send.mockRejectedValueOnce(Object.assign(new Error("Concurrent commitment"), { name: "ConditionalCheckFailedException" }));
    expect(await financeOffer(client as never, account("FL"), anchor, 10_000, "board@example.test")).toBeNull();
    expect(h.originate).not.toHaveBeenCalled();
  });
});
