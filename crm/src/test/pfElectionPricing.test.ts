import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { PF_JURISDICTIONS } from "../../../shared/premiumFinance/jurisdictions";
import { financePricing } from "../../../shared/premiumFinance/pricing";
import { buildQuote } from "../../../shared/premiumFinance/quote";

const m = vi.hoisted(() => ({ lookup: vi.fn(), list: vi.fn(), invoices: vi.fn(), account: vi.fn(), policy: vi.fn(), quote: vi.fn(), send: vi.fn(), checkout: vi.fn(), expire: vi.fn(), void: vi.fn(), storedInvoice: vi.fn(), grouped: vi.fn(), opinions: vi.fn() }));
vi.mock("../../amplify/functions/data-client", () => ({
  createDataClientGetter: () => async () => ({ models: {
    PfLoan: { listPfLoanByElectionToken: m.lookup, list: m.list },
    AgencySettings: { get: async () => ({ data: { premiumFinanceEnabled: true } }) },
    Account: { get: m.account },
    Policy: { get: m.policy },
    Quote: { get: m.quote },
    Invoice: { list: m.invoices },
    PfCounselOpinion: { list: m.opinions },
  } }),
}));
vi.mock("../../amplify/functions/live-write", () => ({ sendCrmWrite: <T>(write: Promise<T>) => write }));
vi.mock("@aws-sdk/lib-dynamodb", async original => ({
  ...await original<typeof import("@aws-sdk/lib-dynamodb")>(),
  DynamoDBDocumentClient: { from: () => ({ send: m.send }) },
}));
vi.mock("stripe", () => ({ default: class { checkout = { sessions: { create: m.checkout, expire: m.expire } }; } }));
vi.mock("../../amplify/functions/void-invoice/handler", () => ({ handler: m.void }));
vi.mock("../../amplify/functions/quote-source-billing", () => ({ zeroFeeQuoteClaimWrites: async () => [] }));
vi.mock("../../amplify/functions/grouped-finance", () => ({ loadGroupedFinance: m.grouped }));
vi.mock("../../amplify/functions/broker-fees/store", async original => ({
  ...await original<typeof import("../../amplify/functions/broker-fees/store")>(),
  getModel: async (model: string, id: string) => {
    if (model === "Invoice") return m.storedInvoice(id);
    const { data, errors } = await m.policy({ id });
    if (errors?.length) throw new Error("Policy read failed");
    return data ? { id, ...data } : undefined;
  },
}));
vi.mock("../../amplify/functions/broker-fees/bindValidation", () => ({ assertBrokerFeeSigned: vi.fn() }));
import { handler as elect } from "../../amplify/functions/pf-election/handler";

const inputs = { premium: 10000, downPct: 25, months: 11, effectiveDate: "2026-12-15" };
const decemberApr = financePricing(PF_JURISDICTIONS.find(state => state.code === "IA")!, inputs, "2026-12-15")!.apr;
const offer = (extra: Record<string, unknown> = {}) => ({
  id: "loan-1", accountId: "account-1", policyId: "policy-1", state: "IA", status: "QUOTED",
  ...inputs, ...buildQuote({ ...inputs, apr: decemberApr }), apr: decemberApr,
  coverageEffectiveDate: inputs.effectiveDate,
  electionToken: "a".repeat(43), electionTokenExpiresAt: "2027-03-01T00:00:00Z",
  brokerFeeCents: 0,
  ...extra,
});
const accept = () => elect({ arguments: {
  accept: true, token: "a".repeat(43), signerName: "Alex Signer", signerRole: "Treasurer",
} });
const signature = () => m.send.mock.calls.map(([command]) => command)
  .filter((command): command is TransactWriteCommand => command instanceof TransactWriteCommand)
  .flatMap(command => command.input.TransactItems ?? [])
  .find(write => write.Update?.UpdateExpression?.includes("agreementSignedAt ="))?.Update;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-01-15T18:00:00Z"));
  vi.stubEnv("PF_LOAN_TABLE", "Loans");
  vi.stubEnv("POLICY_TABLE", "Policies");
  vi.stubEnv("AGENCY_SETTINGS_TABLE", "Settings");
  vi.stubEnv("STRIPE_SECRET_KEY", "test-placeholder");
  vi.stubEnv("SITE_URL", "https://example.test");
  vi.stubEnv("PF_COMPLIANCE_LOG_TABLE", "");
  m.lookup.mockResolvedValue({ data: [offer()] });
  m.list.mockResolvedValue({ data: [] });
  m.invoices.mockResolvedValue({ data: [] });
  m.storedInvoice.mockResolvedValue(undefined);
  m.account.mockResolvedValue({ data: { name: "Test Association", state: "IA" } });
  m.policy.mockResolvedValue({ data: { accountId: "account-1", effectiveDate: inputs.effectiveDate } });
  m.quote.mockResolvedValue({ data: { accountId: "account-1", effectiveDate: inputs.effectiveDate } });
  m.send.mockResolvedValue({ Item: { premiumFinanceEnabled: true } });
  m.checkout.mockResolvedValue({ id: "cs-1", url: "https://checkout.stripe.test/new", expires_at: 1800000000 });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe.each([
  { state: "DE", source: "policy" as const, anchor: { policyId: "policy-1", quoteId: null }, id: "policy-1" },
  { state: "KS", source: "quote" as const, anchor: { policyId: null, quoteId: "quote-1" }, id: "quote-1" },
])("$state coverage inception at first signature", ({ state, source, anchor, id }) => {
  beforeEach(() => {
    m.account.mockResolvedValue({ data: { name: "Test Association", state } });
    m.lookup.mockResolvedValue({ data: [offer({ state, apr: 6, ...anchor })] });
  });

  it("closes an unsigned offer after its current coverage inception changes", async () => {
    m[source].mockResolvedValue({ data: { accountId: "account-1", effectiveDate: "2026-11-15" } });
    expect(await accept()).toMatchObject({ state: "closed", reason: "This financing offer is no longer open. Your agent can issue a fresh one." });
    expect(m.send).not.toHaveBeenCalled();
    expect(m.void).not.toHaveBeenCalled();
    expect(m.checkout).not.toHaveBeenCalled();
  });

  it("accepts the offer when its current coverage inception still matches", async () => {
    expect(await accept()).toMatchObject({ state: "checkout" });
    expect(m[source]).toHaveBeenCalledExactlyOnceWith({ id });
    expect(signature()).toBeDefined();
    expect(m.checkout).toHaveBeenCalledTimes(1);
  });

  it("refreshes the signature time after verifying current coverage", async () => {
    m[source].mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2027-01-16T18:00:00Z"));
      return { data: { accountId: "account-1", effectiveDate: inputs.effectiveDate } };
    });
    expect(await accept()).toMatchObject({ state: "checkout" });
    expect(signature()?.ExpressionAttributeValues?.[":now"]).toBe("2027-01-16T18:00:00.000Z");
  });

  it.each([
    { data: null },
    { data: { accountId: "account-1", effectiveDate: null } },
    { data: { accountId: "other-account", effectiveDate: inputs.effectiveDate } },
    { data: { accountId: "account-1", effectiveDate: inputs.effectiveDate }, errors: [{ message: "Coverage could not be verified" }] },
  ])("closes an unsigned offer when current coverage cannot be verified: %j", async response => {
    m[source].mockResolvedValue(response);
    expect(await accept()).toMatchObject({ state: "closed", reason: "This financing offer is no longer open. Your agent can issue a fresh one." });
    expect(m.send).not.toHaveBeenCalled();
    expect(m.void).not.toHaveBeenCalled();
    expect(m.checkout).not.toHaveBeenCalled();
  });

  it("closes an unsigned offer when the coverage read rejects", async () => {
    m[source].mockRejectedValueOnce(new Error("Coverage service unavailable"));
    expect(await accept()).toMatchObject({ state: "closed", reason: "This financing offer is no longer open. Your agent can issue a fresh one." });
    expect(m.send).not.toHaveBeenCalled();
    expect(m.void).not.toHaveBeenCalled();
    expect(m.checkout).not.toHaveBeenCalled();
  });

  it("preserves a signed agreement after the current coverage inception changes", async () => {
    m.lookup.mockResolvedValue({ data: [offer({ state, ...anchor, electedAt: "2026-12-15T18:00:00Z", agreementSignedAt: "2026-12-15T18:00:00Z" })] });
    m[source].mockResolvedValue({ data: { accountId: "account-1", effectiveDate: "2026-11-15" } });
    expect(await accept()).toMatchObject({ state: "checkout" });
    expect(m[source]).not.toHaveBeenCalled();
    expect(signature()).toBeUndefined();
    expect(m.checkout).toHaveBeenCalledTimes(1);
  });
});

describe("financing rate at first signature", () => {
  it("closes an unsigned December Iowa offer when January's ceiling is unpublished", async () => {
    expect(await accept()).toMatchObject({ state: "closed", reason: "This financing offer is no longer open. Your agent can issue a fresh one." });
    expect(signature()).toBeUndefined();
    expect(m.send).not.toHaveBeenCalled();
    expect(m.void).not.toHaveBeenCalled();
    expect(m.checkout).not.toHaveBeenCalled();
  });

  it("leaves an already signed agreement available without checking a later month's ceiling", async () => {
    m.lookup.mockResolvedValue({ data: [offer({ electedAt: "2026-12-15T18:00:00Z", agreementSignedAt: "2026-12-15T18:00:00Z" })] });
    expect(await accept()).toMatchObject({ state: "checkout", url: "https://checkout.stripe.test/new" });
    expect(signature()).toBeUndefined();
    expect(m.checkout).toHaveBeenCalledTimes(1);
  });

  it("preserves a legacy election with an existing live Checkout session", async () => {
    m.lookup.mockResolvedValue({ data: [offer({
      electionCheckoutUrl: "https://checkout.stripe.test/existing",
      electionCheckoutExpiresAt: "2027-01-15T19:00:00Z", electionCheckoutBillingVersion: 3,
    })] });
    expect(await accept()).toMatchObject({ state: "checkout", url: "https://checkout.stripe.test/existing" });
    expect(m.checkout).not.toHaveBeenCalled();
  });

  it("preserves a legacy recorded election after its published rate period", async () => {
    m.lookup.mockResolvedValue({ data: [offer({ electedAt: "2026-12-15T18:00:00Z" })] });
    expect(await accept()).toMatchObject({ state: "checkout" });
    expect(m.checkout).toHaveBeenCalledTimes(1);
  });

  it("preserves the existing clearing-payment path without a new rate decision", async () => {
    m.lookup.mockResolvedValue({ data: [offer({ downPaymentIntentId: "pi-clearing" })] });
    expect(await accept()).toMatchObject({ state: "closed", reason: expect.stringContaining("already clearing") });
    expect(m.send).not.toHaveBeenCalled();
    expect(m.checkout).not.toHaveBeenCalled();
  });

  it("allows a lower stored rate within the current ceiling without repricing its terms", async () => {
    vi.setSystemTime(new Date("2026-11-15T18:00:00Z"));
    m.lookup.mockResolvedValue({ data: [offer({
      ...buildQuote({ ...inputs, apr: 6 }), apr: 6,
    })] });
    expect(await accept()).toMatchObject({ state: "checkout" });
    expect(signature()).toBeDefined();
    for (const [command] of m.send.mock.calls) {
      const updates = command.input.TransactItems?.flatMap((write: { Update?: { UpdateExpression?: string } }) => write.Update?.UpdateExpression ?? []) ?? [];
      if (command.input.UpdateExpression) updates.push(command.input.UpdateExpression);
      expect(updates.every((expression: string) => !/\b(apr|schedule|payment)\s*=/.test(expression))).toBe(true);
    }
    expect(m.checkout).toHaveBeenCalledTimes(1);
  });

  it("refuses an unsigned stored rate above the current ceiling", async () => {
    vi.setSystemTime(new Date("2026-11-15T18:00:00Z"));
    expect(await accept()).toMatchObject({ state: "closed" });
    expect(signature()).toBeUndefined();
    expect(m.checkout).not.toHaveBeenCalled();
  });

  it("uses Iowa's calendar month when UTC has already reached December", async () => {
    vi.setSystemTime(new Date("2026-12-01T00:30:00Z"));
    expect(await accept()).toMatchObject({ state: "closed" });
    expect(signature()).toBeUndefined();
    expect(m.checkout).not.toHaveBeenCalled();
  });

  it("rechecks the month immediately before signing after asynchronous reads", async () => {
    vi.setSystemTime(new Date("2026-12-31T23:59:00-06:00"));
    m.invoices.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2027-01-01T00:01:00-06:00"));
      return { data: [] };
    });
    expect(await accept()).toMatchObject({ state: "closed" });
    expect(signature()).toBeUndefined();
    expect(m.checkout).not.toHaveBeenCalled();
  });

  it("rechecks the month after reading the current account state", async () => {
    vi.setSystemTime(new Date("2026-12-31T23:59:00-06:00"));
    m.account.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2027-01-01T00:01:00-06:00"));
      return { data: { name: "Test Association", state: "IA" } };
    });
    expect(await accept()).toMatchObject({ state: "closed" });
    expect(signature()).toBeUndefined();
    expect(m.checkout).not.toHaveBeenCalled();
  });

  it.each(["DE", "KS"])("closes an unsigned %s offer whose coverage inception was not stored", async state => {
    m.account.mockResolvedValue({ data: { name: "Test Association", state } });
    m.lookup.mockResolvedValue({ data: [offer({ state, apr: 6, coverageEffectiveDate: null })] });
    expect(await accept()).toMatchObject({ state: "closed" });
    expect(signature()).toBeUndefined();
    expect(m.checkout).not.toHaveBeenCalled();
  });

  it.each(["DE", "KS"])("checks an unsigned %s offer using its stored coverage inception", async state => {
    m.account.mockResolvedValue({ data: { name: "Test Association", state } });
    m.lookup.mockResolvedValue({ data: [offer({ state, apr: 6 })] });
    expect(await accept()).toMatchObject({ state: "checkout" });
    expect(signature()).toBeDefined();
    expect(m.checkout).toHaveBeenCalledTimes(1);
  });

  it.each(["DE", "KS"])("preserves an already signed %s agreement without a stored coverage inception", async state => {
    m.lookup.mockResolvedValue({ data: [offer({ state, coverageEffectiveDate: null, electedAt: "2026-12-15T18:00:00Z", agreementSignedAt: "2026-12-15T18:00:00Z" })] });
    expect(await accept()).toMatchObject({ state: "checkout" });
    expect(signature()).toBeUndefined();
    expect(m.checkout).toHaveBeenCalledTimes(1);
  });
});

describe("financing jurisdiction at first signature", () => {
  beforeEach(() => {
    vi.setSystemTime(new Date("2026-11-15T18:00:00Z"));
    const maApr = financePricing(PF_JURISDICTIONS.find(state => state.code === "MA")!, inputs, "2026-11-15")!.apr;
    m.lookup.mockResolvedValue({ data: [offer({ state: "MA", ...buildQuote({ ...inputs, apr: maApr }), apr: maApr })] });
    m.account.mockResolvedValue({ data: { name: "Test Association", state: "MA" } });
  });

  it("closes a previously quoted standalone offer on a policy reserved for grouped review", async () => {
    m.policy.mockResolvedValue({ data: { accountId: "account-1", groupedDraftInvoiceId: "group-1" } });
    m.storedInvoice.mockResolvedValue({ accountId: "account-1", sourcePricingVersion: 3, groupedPolicyIds: ["policy-1", "policy-2"], status: "DRAFT" });
    expect(await accept()).toMatchObject({ state: "closed" });
    expect(m.storedInvoice).toHaveBeenCalledWith("group-1");
    expect(m.send).not.toHaveBeenCalled();
    expect(m.void).not.toHaveBeenCalled();
    expect(m.checkout).not.toHaveBeenCalled();
  });

  it("guards the first signature transaction against a concurrent grouped reservation", async () => {
    m.send.mockImplementation(async command => {
      expect(command).toBeInstanceOf(TransactWriteCommand);
      expect(command.input.TransactItems).toContainEqual({ ConditionCheck: expect.objectContaining({
        TableName: "Policies", Key: { id: "policy-1" }, ConditionExpression: expect.stringContaining("attribute_not_exists(groupedDraftInvoiceId)"),
      }) });
      throw Object.assign(new Error("Group won"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "None" }, { Code: "None" }, { Code: "ConditionalCheckFailed" }] });
    });
    expect(await accept()).toMatchObject({ state: "closed" });
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(m.void).not.toHaveBeenCalled();
    expect(m.checkout).not.toHaveBeenCalled();
  });

  it("closes an unsigned Massachusetts offer after the account's physical state is corrected to Florida", async () => {
    m.account.mockResolvedValue({ data: { name: "Test Association", state: "FL" } });
    expect(await accept()).toMatchObject({ state: "closed", reason: "This financing offer is no longer open. Your agent can issue a fresh one." });
    expect(m.send).not.toHaveBeenCalled();
    expect(m.void).not.toHaveBeenCalled();
    expect(m.checkout).not.toHaveBeenCalled();
  });

  it("accepts a matching state alias and reuses that account read for Checkout", async () => {
    m.account.mockResolvedValue({ data: { name: "Test Association", state: " massachusetts " } });
    expect(await accept()).toMatchObject({ state: "checkout" });
    expect(signature()).toBeDefined();
    expect(m.account).toHaveBeenCalledExactlyOnceWith({ id: "account-1" });
    expect(m.checkout).toHaveBeenCalledTimes(1);
  });

  it.each([
    { data: null },
    { data: { name: "Test Association" } },
    { data: { name: "Test Association", state: "" } },
    { data: { name: "Test Association", state: "Unknown" } },
    { data: { name: "Test Association", state: "MA" }, errors: [{ message: "Account could not be verified" }] },
  ])("closes an unsigned offer when the current account state is unavailable: %j", async response => {
    m.account.mockResolvedValue(response);
    expect(await accept()).toMatchObject({ state: "closed", reason: "This financing offer is no longer open. Your agent can issue a fresh one." });
    expect(m.send).not.toHaveBeenCalled();
    expect(m.void).not.toHaveBeenCalled();
    expect(m.checkout).not.toHaveBeenCalled();
  });

  it("closes an unsigned offer when the account read rejects", async () => {
    m.account.mockRejectedValueOnce(new Error("Account service unavailable"));
    expect(await accept()).toMatchObject({ state: "closed", reason: "This financing offer is no longer open. Your agent can issue a fresh one." });
    expect(m.send).not.toHaveBeenCalled();
    expect(m.void).not.toHaveBeenCalled();
    expect(m.checkout).not.toHaveBeenCalled();
  });

  it("preserves a signed agreement after an account state correction", async () => {
    m.lookup.mockResolvedValue({ data: [offer({ state: "MA", electedAt: "2026-11-14T18:00:00Z", agreementSignedAt: "2026-11-14T18:00:00Z" })] });
    m.account.mockResolvedValue({ data: { name: "Test Association", state: "FL" } });
    expect(await accept()).toMatchObject({ state: "checkout" });
    expect(signature()).toBeUndefined();
    expect(m.checkout).toHaveBeenCalledTimes(1);
  });

  it("preserves an existing live Checkout commitment after an account state correction", async () => {
    m.lookup.mockResolvedValue({ data: [offer({ state: "MA",
      electionCheckoutUrl: "https://checkout.stripe.test/existing",
      electionCheckoutExpiresAt: "2026-11-15T19:00:00Z", electionCheckoutBillingVersion: 3,
    })] });
    m.account.mockResolvedValue({ data: { name: "Test Association", state: "FL" } });
    expect(await accept()).toMatchObject({ state: "checkout", url: "https://checkout.stripe.test/existing" });
    expect(m.account).not.toHaveBeenCalled();
    expect(m.checkout).not.toHaveBeenCalled();
  });
});

describe("published grouped financing election", () => {
  const policyIds = ["p1", "p2", "p3", "p4"];
  const agreementLines = ["Harbor | POL-1 | Commercial Property", "Harbor | POL-2 | General Liability", "Harbor | POL-3 | Umbrella", "Travelers | POL-4 | D&O"];
  const groupLoan = (patch: Record<string, unknown> = {}) => offer({
    policyId: null, state: "MA", apr: 18, ...buildQuote({ ...inputs, apr: 18 }),
    groupedInvoiceId: "group-1", groupedPolicyIds: policyIds, groupedPolicyAgreementLines: agreementLines,
    // AppSync AWSJSON wraps the empty allocation list stored by origination.
    brokerFeeAllocations: JSON.stringify(JSON.stringify([])),
    ...patch,
  });
  const group = () => ({
    invoice: { id: "group-1", accountId: "account-1", status: "SENT", sentAt: "2026-12-15T18:00:00Z", groupedFinanceLoanId: "loan-1" },
    account: { id: "account-1", name: "Test Association", state: "MA", type: "ASSOCIATION", incorporated: true },
    premium: inputs.premium,
    policies: policyIds.map((id, i) => ({ id, effectiveDate: inputs.effectiveDate, lines: [["Commercial Property", "General Liability", "Umbrella", "D&O"][i]] })),
    agreementLines,
    guards: policyIds.map(id => ({ ConditionCheck: { TableName: "Policies", Key: { id }, ConditionExpression: "updatedAt = :old" } })),
    invoiceGuard: { ConditionCheck: { TableName: "Invoices", Key: { id: "group-1" }, ConditionExpression: "updatedAt = :old", ExpressionAttributeValues: { ":old": "version" } } },
  });
  const terms = () => elect({ arguments: { token: "a".repeat(43) } });

  beforeEach(() => {
    m.lookup.mockResolvedValue({ data: [groupLoan()] });
    m.grouped.mockResolvedValue(group());
    m.expire.mockResolvedValue({});
    m.opinions.mockResolvedValue({ data: [] });
  });

  it("shows every frozen policy and marks the published offer financing-only", async () => {
    expect(await terms()).toMatchObject({ state: "open", financingOnly: true, finalPayment: groupLoan().schedule.at(-1)?.payment,
      initialPaymentAmount: 2510, agreementTerms: expect.arrayContaining([
      ...agreementLines, expect.stringContaining("insurance policies identified above"),
    ]) });
    expect(m.grouped).toHaveBeenCalledExactlyOnceWith(expect.anything(), "group-1");
    expect(m.send).not.toHaveBeenCalled();
  });

  it("refuses a grouped offer with fee allocations in the AppSync representation", async () => {
    m.lookup.mockResolvedValue({ data: [groupLoan({
      brokerFeeAllocations: JSON.stringify(JSON.stringify([{ quoteId: "q1", amountCents: 100 }])),
    })] });
    expect(await terms()).toMatchObject({ state: "closed" });
    expect(await accept()).toMatchObject({ state: "closed" });
    expect(m.grouped).not.toHaveBeenCalled();
    expect(m.checkout).not.toHaveBeenCalled();
  });

  it("guards signing, checkout claim and URL publication on the same group and never opens a full-pay path", async () => {
    expect(await accept()).toEqual({ ok: true, state: "checkout", url: "https://checkout.stripe.test/new" });
    const transactions = m.send.mock.calls.map(([command]) => command)
      .filter((command): command is TransactWriteCommand => command instanceof TransactWriteCommand);
    expect(transactions).toHaveLength(3);
    for (const { input } of transactions) {
      expect(input.TransactItems).toContainEqual({ ConditionCheck: expect.objectContaining({
        TableName: "Invoices", Key: { id: "group-1" },
        ConditionExpression: expect.stringContaining("groupedFinanceLoanId = :groupLoan"),
        ExpressionAttributeValues: expect.objectContaining({ ":groupLoan": "loan-1", ":groupSent": "SENT" }),
      }) });
      for (const id of policyIds) expect(input.TransactItems).toContainEqual({ ConditionCheck: expect.objectContaining({ TableName: "Policies", Key: { id } }) });
    }
    expect(signature()).toBeDefined();
    expect(m.list).not.toHaveBeenCalled();
    expect(m.invoices).not.toHaveBeenCalled();
    expect(m.void).not.toHaveBeenCalled();
    expect(m.checkout).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      payment_method_types: ["us_bank_account"],
      line_items: [expect.objectContaining({ price_data: expect.objectContaining({ unit_amount: 250000 }) }),
        expect.objectContaining({ price_data: expect.objectContaining({ unit_amount: 1000 }) })],
      payment_intent_data: expect.objectContaining({ metadata: expect.objectContaining({ pfLoanId: "loan-1", pfKind: "down" }) }),
    }));
    expect(m.checkout.mock.calls[0][0].payment_intent_data.metadata).not.toHaveProperty("invoiceId");
  });

  it.each([
    { status: "DRAFT" }, { sentAt: null }, { groupedFinanceLoanId: "different-loan" },
    { stripePaymentLinkId: "public-link" }, { paymentUrl: "https://example.test/pay" },
  ])("closes an unverified publication before signature: %j", async patch => {
    const current = group();
    m.grouped.mockResolvedValue({ ...current, invoice: { ...current.invoice, ...patch } });
    expect(await terms()).toMatchObject({ state: "closed" });
    expect(await accept()).toMatchObject({ state: "closed" });
    expect(m.send).not.toHaveBeenCalled();
    expect(m.checkout).not.toHaveBeenCalled();
    expect(m.void).not.toHaveBeenCalled();
  });

  it.each([
    { premium: 10001 }, { policies: [{ id: "p1" }, { id: "p2" }, { id: "p3" }, { id: "other" }] },
    { agreementLines: ["Changed policy", ...agreementLines.slice(1)] },
  ])("closes when the current group no longer matches frozen terms: %j", async patch => {
    m.grouped.mockResolvedValue({ ...group(), ...patch });
    expect(await accept()).toMatchObject({ state: "closed" });
    expect(m.send).not.toHaveBeenCalled();
    expect(m.checkout).not.toHaveBeenCalled();
  });

  it("does not release a newly minted session if the group moved after checkout claim", async () => {
    m.send.mockImplementation(async command => {
      if (command instanceof TransactWriteCommand && command.input.TransactItems?.some(write => write.Update?.UpdateExpression?.includes("electionCheckoutUrl = :url"))) {
        throw Object.assign(new Error("Group changed"), { name: "TransactionCanceledException" });
      }
      return { Item: { premiumFinanceEnabled: true } };
    });
    expect(await accept()).toMatchObject({ state: "closed" });
    expect(m.checkout).toHaveBeenCalledTimes(1);
    expect(m.expire).toHaveBeenCalledExactlyOnceWith("cs-1");
  });

  it.each([
    { state: "MA", type: "PERSONAL", incorporated: true },
    { state: "RI", type: "ASSOCIATION", incorporated: false },
  ])("refuses the first signature when the current borrower is ineligible: %j", async account => {
    m.lookup.mockResolvedValue({ data: [groupLoan({ state: account.state })] });
    const current = group();
    m.grouped.mockResolvedValue({ ...current, account: { ...current.account, ...account } });
    expect(await accept()).toMatchObject({ state: "closed" });
    expect(m.send).not.toHaveBeenCalled();
    expect(m.checkout).not.toHaveBeenCalled();
  });

  it("refuses first signature when a member has personal coverage", async () => {
    const current = group();
    current.policies[0].lines = ["HO-6"];
    m.grouped.mockResolvedValue(current);
    expect(await accept()).toMatchObject({ state: "closed" });
    expect(m.send).not.toHaveBeenCalled();
  });

  it.each([false, true])("requires a current opinion before the first Utah signature (current: %s)", async current => {
    m.lookup.mockResolvedValue({ data: [groupLoan({ state: "UT" })] });
    const live = group();
    m.grouped.mockResolvedValue({ ...live, account: { ...live.account, state: "UT" } });
    m.opinions.mockResolvedValue({ data: [{ effectiveAt: "2026-01-01", reviewBy: current ? "2027-12-31" : "2026-12-31" }] });
    expect(await accept()).toMatchObject({ state: current ? "checkout" : "closed" });
    expect(m.opinions).toHaveBeenCalledExactlyOnceWith({ filter: { jurisdiction: { eq: "UT" } }, nextToken: undefined });
    if (!current) expect(m.send).not.toHaveBeenCalled();
  });

  it("keeps the signed Utah offer when its counsel opinion has expired", async () => {
    m.lookup.mockResolvedValue({ data: [groupLoan({ state: "UT", agreementSignedAt: "2026-12-15T18:00:00Z", electedAt: "2026-12-15T18:00:00Z" })] });
    const live = group();
    m.grouped.mockResolvedValue({ ...live, account: { ...live.account, state: "UT" } });
    expect(await accept()).toMatchObject({ state: "checkout" });
    expect(m.opinions).not.toHaveBeenCalled();
    expect(signature()).toBeUndefined();
  });

  it("retains a settled election without checking the published group again", async () => {
    m.lookup.mockResolvedValue({ data: [groupLoan({ status: "ACTIVE" })] });
    expect(await terms()).toMatchObject({ state: "active" });
    expect(await accept()).toEqual({ ok: true, state: "done" });
    expect(m.grouped).not.toHaveBeenCalled();
    expect(m.checkout).not.toHaveBeenCalled();
  });
});
