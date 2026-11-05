import { invalidateLiveUpdates } from "../test/liveUpdates";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listAllPages } from "../../../shared/pagination";
import type { Account } from "../lib/client";

const h = vi.hoisted(() => ({ preview: vi.fn(), fee: vi.fn(), bind: vi.fn(), quotes: vi.fn(), update: vi.fn(), carriers: vi.fn(), getQuote: vi.fn(), policies: vi.fn(), createPolicy: vi.fn(), accountUpdate: vi.fn(), request: vi.fn(), children: vi.fn() }));
vi.mock("./QuotePackages", () => ({ default: () => null }));
vi.mock("./CoverageForm", () => ({ default: () => null }));
vi.mock("../lib/useAgencyDay", () => ({ useAgencyDay: () => "2026-11-03" }));
vi.mock("../lib/communications", () => ({ communicationRequest: h.request }));
vi.mock("../lib/client", () => ({
  client: { queries: { carrierPaymentPreview: h.preview }, mutations: { bindCommissionPolicy: h.bind, brokerFeeAction: h.fee }, models: { Quote: { list: h.quotes, update: h.update, get: h.getQuote }, Carrier: { list: h.carriers }, Policy: { list: h.policies, create: h.createPolicy }, Account: { update: h.accountUpdate }, Invoice: { list: h.children }, Document: { list: h.children }, PfLoan: { list: h.children } } },
  listAllPages: (...args: Parameters<typeof listAllPages>) => listAllPages(...args),
  friendlyError: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback,
  fmtDate: (value: string) => value || "—",
  fmtMoney: (value: number) => value == null ? "—" : `$${value}`,
}));
import QuotesPanel from "./QuotesPanel";
import { emptyCommercialPlan } from "../../../shared/quotePackages";
import { authorizedQuoteTerms } from "../../../shared/quoteAuthorization";

const account = { id: "account-a", stage: "LEAD" } as Account;
const quote = {
  id: "quote-a", accountId: account.id, carrierId: "carrier-a", status: "QUOTED",
  lines: ["Commercial Property"], premium: 12000, commissionPct: 10,
  effectiveDate: "2026-10-01", expirationDate: "2027-10-01", createdAt: "2026-09-01T12:00:00Z",
};
function pendingQuotes() {
  let resolve!: (result: { data: typeof quote[] }) => void;
  const promise = new Promise<{ data: typeof quote[] }>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  h.preview.mockResolvedValue({ data: { ok: true, carrierTermsVersion: 4, basis: 'COLLECTED' } });
  h.fee.mockResolvedValue({ data: { ok: true, fees: [] } });
  h.bind.mockResolvedValue({ data: { ok: true, policy: { id: "policy-a" }, account: { ...account, stage: "CLIENT" } } });
  h.carriers.mockResolvedValue({ data: [{ id: "carrier-a", name: "Harbor Mutual" }] });
  h.update.mockResolvedValue({ data: quote });
  h.getQuote.mockResolvedValue({ data: quote });
  h.policies.mockResolvedValue({ data: [] });
  h.createPolicy.mockResolvedValue({ data: { id: "policy-a" } });
  h.accountUpdate.mockResolvedValue({ data: { ...account, stage: "CLIENT" } });
  h.children.mockResolvedValue({ data: [] });
  h.request.mockResolvedValue({ items: [{ plan: emptyCommercialPlan(account.id) }] });
});

describe("quote loading and retries", () => {
  it.each([false, true])("keeps a failed load in the loading state until its retry settles (has quotes: %s)", async hasQuotes => {
    const retry = pendingQuotes();
    h.quotes.mockRejectedValueOnce(new Error("Quote read failed"))
      .mockReturnValueOnce(retry.promise);
    render(<QuotesPanel account={account} onAccountChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry quotes" }));
    expect(screen.getByText("Loading quotes…")).toBeVisible();
    expect(screen.queryByText("No quotes yet")).toBeNull();
    expect(screen.queryByText("Quote read failed")).toBeNull();

    await act(async () => retry.resolve({ data: hasQuotes ? [quote] : [] }));
    expect(screen.queryByText("Loading quotes…")).toBeNull();
    if (hasQuotes) {
      expect(screen.getByRole("table", { name: "Carrier quotes" })).toBeVisible();
      expect(screen.getByText("Harbor Mutual")).toBeVisible();
      expect(screen.queryByText("No quotes yet")).toBeNull();
    } else {
      expect(screen.getByText("No quotes yet")).toBeVisible();
    }
  });

  it("keeps known quotes visible while refreshing after a status change", async () => {
    const refresh = pendingQuotes();
    h.quotes.mockResolvedValueOnce({ data: [quote] }).mockReturnValueOnce(refresh.promise);
    render(<QuotesPanel account={account} onAccountChange={vi.fn()} />);
    await screen.findByRole("table", { name: "Carrier quotes" });
    fireEvent.change(screen.getByRole("combobox", { name: "Quote status" }), { target: { value: "PRESENTED" } });
    await waitFor(() => expect(h.quotes).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Harbor Mutual")).toBeVisible();
    expect(screen.getByRole("table", { name: "Carrier quotes" }).closest("[aria-busy]")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("Loading quotes…")).toBeNull();
    expect(screen.queryByText("No quotes yet")).toBeNull();
    await act(async () => refresh.resolve({ data: [{ ...quote, status: "PRESENTED" }] }));
    expect(screen.getByRole("combobox", { name: "Quote status" })).toHaveValue("PRESENTED");
  });
});

describe("recorded carrier offer expiry", () => {
  it("shows the valid-through date and urgency without marking closed quotes urgent", async () => {
    h.quotes.mockResolvedValue({ data: [
      { ...quote, id: "today", offerExpiresAt: "2026-11-03" },
      { ...quote, id: "soon", status: "PRESENTED", offerExpiresAt: "2026-11-10" },
      { ...quote, id: "expired", offerExpiresAt: "2026-11-02" },
      { ...quote, id: "bound", status: "BOUND", offerExpiresAt: "2026-11-02" },
      { ...quote, id: "invalid", offerExpiresAt: "2026-02-30" },
      { ...quote, id: "missing" },
    ] });
    render(<QuotesPanel account={account} onAccountChange={vi.fn()} />);
    const table = await screen.findByRole("table", { name: "Carrier quotes" });
    expect(within(table).getByRole("columnheader", { name: "Offer valid through" })).toBeVisible();
    expect(within(table).getByText("Expires today")).toBeVisible();
    expect(within(table).getByText("Expires soon")).toBeVisible();
    expect(within(table).getAllByText("Expired")).toHaveLength(1);
    const bound = within(table).getByText("BOUND").closest("tr")!;
    expect(within(bound).getByText("2026-11-02")).toHaveAttribute("dateTime", "2026-11-02");
    expect(within(bound).queryByText("Expired")).toBeNull();
    expect(within(table).getByText("Invalid date")).toBeVisible();
    expect(within(table).getByText("Not recorded")).toBeVisible();
  });

  it("lets producers sort the account's quotes by recorded offer validity", async () => {
    h.quotes.mockResolvedValue({ data: [
      { ...quote, id: "later", premium: 2000, offerExpiresAt: "2026-11-10" },
      { ...quote, id: "missing", premium: 3000 },
      { ...quote, id: "earlier", premium: 1000, offerExpiresAt: "2026-11-02" },
    ] });
    render(<QuotesPanel account={account} onAccountChange={vi.fn()} />);
    const table = await screen.findByRole("table", { name: "Carrier quotes" });
    fireEvent.click(within(table).getByRole("button", { name: "Offer valid through" }));
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map(row => within(row).getAllByRole("cell")[2].textContent)).toEqual(["$1000", "$2000", "$3000"]);
    expect(h.bind).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });
});


async function openBind() {
  fireEvent.click(await screen.findByRole("button", { name: "Bind" }));
  fireEvent.click(screen.getByLabelText("I confirmed the exact premium and agency commission percentage."));
  fireEvent.change(screen.getByLabelText("Bill type (required)"), { target: { value: "DIRECT" } });
  fireEvent.change(screen.getByLabelText("Policy number (can be added later)"), { target: { value: "POL-123" } });
  await screen.findByText(/Legacy carrier terms: receipt timing is unconfirmed/);
}
describe("binding recovery", () => {
  it('keeps a fee quote agency billed while requiring the current carrier payment arrangement review', async () => {
    const feeQuote = { ...quote, brokerFee: 500, billType: 'AGENCY' as const };
    h.quotes.mockResolvedValue({ data: [feeQuote] });
    h.fee.mockResolvedValue({ data: { ok: true, fees: [{
      quoteId: quote.id, refundedCents: 0, amountCents: 50000, collectedCents: 50000, submittedCents: 50000,
      signedAt: '2026-09-30T12:00:00Z', terms: authorizedQuoteTerms(feeQuote),
    }] } });
    h.preview.mockResolvedValue({ data: { ok: true, carrierTermsVersion: 8, basis: 'COLLECTED', payment: {
      id: 'agency-2026', payor: 'Harbor MGA', trigger: 'COLLECTION', cadence: 'ONCE', lagDays: 0,
    } } });
    render(<QuotesPanel account={account} onAccountChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Bind' }));
    expect(screen.getByLabelText('Bill type (required)')).toHaveValue('AGENCY');
    expect(screen.getByLabelText('Bill type (required)')).toBeDisabled();
    expect(within(screen.getByLabelText('Bill type (required)')).getByRole('option', { name: /^Direct bill/ })).toBeDisabled();
    await screen.findByText('Disclosure signed · payment received.');
    fireEvent.click(screen.getByLabelText('I confirmed the exact premium and agency commission percentage.'));
    const review = await screen.findByLabelText('I reviewed the carrier commission payment arrangement.');
    expect(screen.getByRole('button', { name: 'Confirm bind' })).toBeDisabled();
    fireEvent.click(review);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm bind' }));
    await waitFor(() => expect(h.bind).toHaveBeenCalledTimes(1));
    expect(JSON.parse(h.bind.mock.calls[0][0].input)).toMatchObject({
      billType: 'AGENCY', carrierTermsVersion: 8, carrierArrangementId: 'agency-2026',
    });
    expect(h.preview).toHaveBeenCalledWith({ quoteId: quote.id, billType: 'AGENCY' });
  });

  it('requires editing an invalid direct-billed fee quote before the bind dialog can submit', async () => {
    h.quotes.mockResolvedValue({ data: [{ ...quote, brokerFee: 500, billType: 'DIRECT' }] });
    render(<QuotesPanel account={account} onAccountChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Bind' }));
    expect(screen.getByText(/it needs agency billing for the broker fee/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Confirm bind' })).toBeNull();
    expect(h.preview).not.toHaveBeenCalled();
    expect(h.bind).not.toHaveBeenCalled();
  });

  it('requires review of structured terms and sends the exact selected carrier version', async () => {
    h.quotes.mockResolvedValue({ data: [quote] });
    h.preview.mockResolvedValue({ data: { ok: true, carrierTermsVersion: 7, basis: 'WRITTEN', payment: {
      id: 'direct-2026', payor: 'Harbor MGA', trigger: 'EFFECTIVE', cadence: 'MONTHLY', lagDays: 5,
    } } });
    render(<QuotesPanel account={account} onAccountChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Bind' }));
    fireEvent.change(screen.getByLabelText('Bill type (required)'), { target: { value: 'DIRECT' } });
    fireEvent.click(screen.getByLabelText('I confirmed the exact premium and agency commission percentage.'));
    const review = await screen.findByLabelText('I reviewed the carrier commission payment arrangement.');
    expect(screen.getByRole('button', { name: 'Confirm bind' })).toBeDisabled();
    fireEvent.click(review);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm bind' }));
    await waitFor(() => expect(h.bind).toHaveBeenCalledTimes(1));
    expect(JSON.parse(h.bind.mock.calls[0][0].input)).toMatchObject({
      carrierTermsVersion: 7, carrierArrangementId: 'direct-2026',
    });
  });

  it('blocks binding on a failed terms read and permits a reviewed retry', async () => {
    h.quotes.mockResolvedValue({ data: [quote] });
    h.preview.mockRejectedValueOnce(new Error('Carrier terms unavailable'));
    render(<QuotesPanel account={account} onAccountChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Bind' }));
    fireEvent.change(screen.getByLabelText('Bill type (required)'), { target: { value: 'DIRECT' } });
    fireEvent.click(screen.getByLabelText('I confirmed the exact premium and agency commission percentage.'));
    await screen.findByText('Carrier terms unavailable');
    expect(screen.getByRole('button', { name: 'Confirm bind' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh carrier payment terms' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm bind' })).toBeEnabled());
    expect(h.bind).not.toHaveBeenCalled();
  });

  it("preserves the bill type and policy number after a failed preflight and allows retry", async () => {
    h.quotes.mockResolvedValue({ data: [quote] });
    h.bind.mockRejectedValueOnce(new Error("Temporary quote read failure"));
    const changed = vi.fn();
    render(<QuotesPanel account={account} onAccountChange={changed} />);
    await openBind();
    fireEvent.click(screen.getByRole("button", { name: "Confirm bind" }));
    await screen.findByText("Temporary quote read failure");
    expect(screen.getByLabelText("Policy number (can be added later)")).toHaveValue("POL-123");
    expect(screen.getByLabelText("Bill type (required)")).toHaveValue("DIRECT");
    expect(h.createPolicy).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm bind" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Confirm bind" }));
    await waitFor(() => expect(changed).toHaveBeenCalledWith(expect.objectContaining({ stage: "CLIENT" })));
    expect(JSON.parse(h.bind.mock.calls.at(-1)![0].input)).toMatchObject({ policyNumber: "POL-123", billType: "DIRECT", premium: "12000", agencyRate: "10" });
    expect(h.createPolicy).not.toHaveBeenCalled();
  });

  it("surfaces a rejected server bind without creating client-side records", async () => {
    h.quotes.mockResolvedValue({ data: [quote] });
    h.bind.mockResolvedValue({ data: { ok: false, error: "This quote already has a policy." } });
    render(<QuotesPanel account={account} onAccountChange={vi.fn()} />);
    await openBind(); fireEvent.click(screen.getByRole("button", { name: "Confirm bind" }));
    await screen.findByText("This quote already has a policy.");
    expect(h.createPolicy).not.toHaveBeenCalled();
    expect(h.accountUpdate).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation of exact premium and commission before binding", async () => {
    h.quotes.mockResolvedValue({ data: [quote] });
    render(<QuotesPanel account={account} onAccountChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Bind" }));
    fireEvent.change(screen.getByLabelText("Bill type (required)"), { target: { value: "DIRECT" } });
    expect(screen.getByRole("button", { name: "Confirm bind" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("I confirmed the exact premium and agency commission percentage."));
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm bind" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Exact policy premium"), { target: { value: "12000.01" } });
    expect(screen.getByRole("button", { name: "Confirm bind" })).toBeDisabled();
    expect(h.bind).not.toHaveBeenCalled();
  });

  it("keeps old bind completion from replacing the current account", async () => {
    h.quotes.mockResolvedValue({ data: [quote] });
    let finish!: (value: unknown) => void;
    h.bind.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const changed = vi.fn();
    const view = render(<QuotesPanel account={account} onAccountChange={changed} />);
    await openBind(); fireEvent.click(screen.getByRole("button", { name: "Confirm bind" }));
    await waitFor(() => expect(h.bind).toHaveBeenCalledTimes(1));
    view.rerender(<QuotesPanel account={{ ...account, id: "account-b" }} onAccountChange={changed} />);
    await act(async () => finish({ data: { ok: true, policy: { id: "policy-a" }, account: { ...account, stage: "CLIENT" } } }));
    expect(changed).not.toHaveBeenCalled();
  });
});

it('updates verified broker fee status through an open bind draft without repeating financial actions', async () => {
  const feeQuote = { ...quote, brokerFee: 500, billType: 'AGENCY' as const };
  const fee = { quoteId: quote.id, refundedCents: 0, amountCents: 50000, collectedCents: 0, submittedCents: 0,
    signedAt: '2026-09-30T12:00:00Z', terms: authorizedQuoteTerms(feeQuote) };
  h.quotes.mockResolvedValue({ data: [feeQuote] });
  h.fee.mockResolvedValue({ data: { ok: true, fees: [fee] } });
  render(<QuotesPanel account={account} onAccountChange={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Bind' }));
  await screen.findByText('Disclosure signed · fee payment is still needed.');
  fireEvent.change(screen.getByLabelText('Policy number (can be added later)'), { target: { value: 'MY-BIND-DRAFT' } });
  fireEvent.click(screen.getByLabelText('I confirmed the exact premium and agency commission percentage.'));
  h.fee.mockResolvedValue({ data: { ok: true, fees: [{ ...fee, submittedCents: 50000, collectedCents: 50000 }] } });
  await invalidateLiveUpdates(['CRM']);
  expect(screen.getByText('Disclosure signed · payment received.')).toBeVisible();
  expect(screen.getByLabelText('Policy number (can be added later)')).toHaveValue('MY-BIND-DRAFT');
  expect(screen.getByLabelText('I confirmed the exact premium and agency commission percentage.')).toBeChecked();
  expect(h.quotes).toHaveBeenCalledTimes(1);
  expect(h.bind).not.toHaveBeenCalled();
  expect(h.fee.mock.calls.every(([request]) => JSON.parse(request.input).op === 'status')).toBe(true);
  h.bind.mockImplementationOnce(() => new Promise(() => {}));
  const confirmBind = screen.getByRole('button', { name: 'Confirm bind' });
  fireEvent.click(confirmBind);
  fireEvent.click(confirmBind);
  await waitFor(() => expect(h.bind).toHaveBeenCalledTimes(1));
});
