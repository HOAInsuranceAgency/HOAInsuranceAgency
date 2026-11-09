import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PutCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { originateLoan, type OriginationRequest } from "../../amplify/functions/pfOrigination";
import { buildQuote, effectiveAprWithFee } from "../../../shared/premiumFinance/quote";
import { financePricing } from "../../../shared/premiumFinance/pricing";
import { jurisdictionFor } from "../../../shared/premiumFinance/gate";

vi.mock("../../amplify/functions/live-write", () => ({
  sendCrmWrite: <T>(write: Promise<T>) => write,
}));

const send = vi.fn();
const db = { send } as unknown as DynamoDBDocumentClient;
const reads = { listOpinions: vi.fn().mockResolvedValue([]) };
const request = (state: string, overrides: Partial<OriginationRequest> = {}): OriginationRequest => ({
  account: { id: "account-1", state, type: "ASSOCIATION", incorporated: true },
  anchor: { kind: "policy", id: "policy-1", lines: ["Commercial Property"], coverageEffectiveDate: "2026-11-01" },
  premium: 10_000,
  downPct: 25,
  months: 11,
  effectiveDate: "2026-11-07",
  actor: "actor-1",
  actorName: "Producer",
  ...overrides,
});
const decisions = () => send.mock.calls
  .map(([command]) => command)
  .filter((command): command is PutCommand => command instanceof PutCommand)
  .map(command => command.input.Item!);
const loan = () => {
  const transaction = send.mock.calls
    .map(([command]) => command)
    .find((command): command is TransactWriteCommand => command instanceof TransactWriteCommand);
  return transaction?.input.TransactItems?.find(write => write.Put)?.Put?.Item;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
  vi.stubEnv("PF_COMPLIANCE_LOG_TABLE", "compliance");
  vi.stubEnv("AGENCY_SETTINGS_TABLE", "settings");
  vi.stubEnv("PF_LOAN_TABLE", "loans");
  send.mockResolvedValue({});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("server-owned premium finance pricing", () => {
  it.each([["AK", 15], ["FL", null], ["MN", 18]] as const)(
    "creates a %s quote at the selected rate with no caller-supplied APR",
    async (state, apr) => {
      const req = request(state);
      expect(await originateLoan(db, reads, true, req)).toMatchObject({ ok: true, loanId: expect.any(String), blocks: [] });
      const selectedApr = apr ?? financePricing(jurisdictionFor(state)!, req, "2026-11-07")!.apr;
      const expected = buildQuote({ ...req, apr: selectedApr });
      expect(loan()).toMatchObject({
        state, apr: selectedApr, premium: req.premium, payment: expected.payment,
        totalInterest: expected.totalInterest, schedule: JSON.stringify(expected.schedule),
      });
      expect(decisions().find(row => row.rule === "apr-cap")).toMatchObject({ outcome: "PASS" });
      for (const row of decisions()) expect(JSON.parse(row.inputs).apr).toBe(selectedApr);
    },
  );

  it("keeps the fee-inclusive Rhode Island quote within its effective ceiling", async () => {
    const req = request("RI");
    expect(await originateLoan(db, reads, true, req)).toMatchObject({ ok: true, loanId: expect.any(String) });
    const saved = loan()!;
    expect(saved.apr).toBeLessThan(21);
    const quote = buildQuote({ ...req, apr: saved.apr });
    expect(effectiveAprWithFee(quote)).toBeLessThanOrEqual(21);
    expect(saved.schedule).toBe(JSON.stringify(quote.schedule));
  });

  it.each([14, 18.01, NaN, Infinity])("refuses a caller rate of %s instead of the selected Florida rate", async apr => {
    expect(await originateLoan(db, reads, true, request("FL", { apr }))).toMatchObject({
      ok: true, loanId: null, blocks: [expect.objectContaining({ rule: "apr-cap" })],
    });
    expect(loan()).toBeUndefined();
    const audit = decisions().find(row => row.rule === "apr-cap")!;
    expect(audit.outcome).toBe("BLOCK");
    expect(JSON.parse(audit.inputs).apr).toBe(financePricing(jurisdictionFor("FL")!, request("FL"), "2026-11-07")!.apr);
    // Finite attempted rates are retained separately from the actual rate.
    if (Number.isFinite(apr)) expect(JSON.parse(audit.inputs).requestedApr).toBe(apr);
  });

  it("accepts an API assertion only when it matches the selected rate", async () => {
    expect(await originateLoan(db, reads, true, request("AK", { apr: 15 }))).toMatchObject({ ok: true, loanId: expect.any(String) });
    expect(loan()?.apr).toBe(15);
  });

  it("never creates a standalone loan when a grouped policy claim wins the origination transaction", async () => {
    vi.stubEnv("POLICY_TABLE", "policy-table");
    const { standalonePolicyBillingGuard } = await import("../../amplify/functions/grouped-draft-billing");
    const guard = standalonePolicyBillingGuard({ id: "policy-1" });
    send.mockImplementation(async (command) => {
      if (command instanceof TransactWriteCommand) {
        expect(command.input.TransactItems).toContainEqual(guard);
        expect(guard.ConditionCheck?.ConditionExpression).toContain("attribute_not_exists(groupedDraftInvoiceId)");
        throw Object.assign(new Error("Group won"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "None" }, { Code: "None" }, { Code: "ConditionalCheckFailed" }] });
      }
      return {};
    });
    await expect(originateLoan(db, reads, true, request("AK", { policyGuard: guard }))).resolves.toMatchObject({ ok: false });
    expect(decisions().filter(row => row.rule === "module-flag").every(row => row.outcome !== "BLOCK")).toBe(true);
  });

  it("blocks pricing when the dated state ceiling has no value for the agreement date", async () => {
    vi.setSystemTime(new Date("2027-01-07T12:00:00Z"));
    const result = await originateLoan(db, reads, true, request("ND"));
    expect(result).toMatchObject({ ok: true, loanId: null, blocks: [expect.objectContaining({ rule: "apr-cap" })] });
    expect(loan()).toBeUndefined();
    expect(decisions().find(row => row.rule === "apr-cap")?.outcome).toBe("BLOCK");
  });

  it("uses the server's transaction month while preserving the requested schedule anchor", async () => {
    const req = request("IA", { effectiveDate: "2026-12-07" });
    // November is configured at 7%; the caller's December schedule date
    // must not select December's higher 7.25% limit.
    const selected = financePricing(jurisdictionFor("IA")!, req, "2026-11-07")!;
    expect(await originateLoan(db, reads, true, req)).toMatchObject({ ok: true, loanId: expect.any(String) });
    expect(loan()).toMatchObject({ apr: selected.apr, effectiveDate: "2026-12-07" });
    expect(JSON.parse(loan()!.schedule)[0].dueDate).toBe("2027-01-07");
    expect(JSON.parse(decisions().find(row => row.rule === "apr-cap")!.inputs)).toMatchObject({
      apr: selected.apr, rateDate: ["2026-11-07"], effectiveDate: "2026-12-07",
    });
    send.mockClear();
    const futureApr = financePricing(jurisdictionFor("IA")!, req, "2026-12-07")!.apr;
    expect(futureApr).toBeGreaterThan(selected.apr);
    expect(await originateLoan(db, reads, true, { ...req, apr: futureApr })).toMatchObject({
      ok: true, loanId: null, blocks: [expect.objectContaining({ rule: "apr-cap" })],
    });
    expect(loan()).toBeUndefined();
  });

  it("prices Iowa in its local month across a UTC month boundary", async () => {
    vi.setSystemTime(new Date("2026-12-01T00:30:00Z"));
    const req = request("IA", { effectiveDate: "2026-12-01" });
    const november = financePricing(jurisdictionFor("IA")!, req, "2026-11-30")!;
    expect(await originateLoan(db, reads, true, req)).toMatchObject({ ok: true, loanId: expect.any(String) });
    expect(loan()?.apr).toBe(november.apr);
    expect(JSON.parse(decisions().find(row => row.rule === "apr-cap")!.inputs).rateDate).toEqual(["2026-11-30"]);
  });

  it("starts the Delaware charge period at coverage inception for an early invoice", async () => {
    const req = request("DE");
    req.anchor.coverageEffectiveDate = "2027-01-01";
    const fromInvoice = financePricing(jurisdictionFor("DE")!, { ...req, coverageEffectiveDate: req.effectiveDate }, "2026-11-07")!;
    expect(await originateLoan(db, reads, true, req)).toMatchObject({ ok: true, loanId: expect.any(String) });
    expect(loan()).toMatchObject({ coverageEffectiveDate: "2027-01-01", effectiveDate: req.effectiveDate });
    expect(loan()!.apr).toBeLessThan(fromInvoice.apr);
    const schedule = JSON.parse(loan()!.schedule);
    const days = (Date.parse(schedule.at(-1).dueDate) - Date.parse("2027-01-01")) / 86_400_000;
    expect(loan()!.totalInterest).toBeLessThanOrEqual(7_500 * 0.09 * days / 365);
    expect(JSON.parse(decisions().find(row => row.rule === "apr-cap")!.inputs).coverageEffectiveDate).toBe("2027-01-01");
  });

  it("does not invent an add-on charge period when the policy has no coverage date", async () => {
    const req = request("DE");
    delete req.anchor.coverageEffectiveDate;
    expect(await originateLoan(db, reads, true, req)).toMatchObject({
      ok: true, loanId: null, blocks: [expect.objectContaining({ rule: "apr-cap" })],
    });
    expect(loan()).toBeUndefined();
  });

  it("keeps a closed jurisdiction closed even when a caller supplies a rate", async () => {
    expect(await originateLoan(db, reads, true, request("NY", { apr: 18 }))).toMatchObject({
      ok: true, loanId: null, blocks: [expect.objectContaining({ rule: "jurisdiction-gate" })],
    });
    expect(loan()).toBeUndefined();
  });

  it("requires the pricing decision log to land before creating the loan", async () => {
    send.mockImplementation(async command => {
      if (command instanceof PutCommand && command.input.Item?.rule === "apr-cap") throw new Error("audit unavailable");
      return {};
    });
    expect(await originateLoan(db, reads, true, request("AK"))).toMatchObject({ ok: false, error: expect.stringContaining("NOT issued") });
    expect(loan()).toBeUndefined();
  });

  it("retains the transactional kill switch after automatic pricing", async () => {
    await originateLoan(db, reads, true, request("AK"));
    const transaction = send.mock.calls.map(([command]) => command).find(command => command instanceof TransactWriteCommand);
    expect(transaction?.input.TransactItems?.[0]?.ConditionCheck).toMatchObject({
      TableName: "settings", Key: { id: "AGENCY" },
      ConditionExpression: "premiumFinanceEnabled = :on", ExpressionAttributeValues: { ":on": true },
    });
  });
});
