import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  models: {
    Invoice: { list: vi.fn(), create: vi.fn() }, InvoiceLine: { list: vi.fn(), create: vi.fn() },
    Policy: { list: vi.fn() }, Quote: { list: vi.fn() }, Contact: { list: vi.fn() }, Account: { get: vi.fn() },
  },
  mutations: { reserveInvoiceNumber: vi.fn(), createGroupedInvoice: vi.fn() },
}));
vi.mock("aws-amplify/data", () => ({ generateClient: () => api }));
vi.mock("../../components/InvoiceEditor", () => ({ InvoiceEditor: ({ invoice }: { invoice: { id: string } }) => <div>Editing {invoice.id}</div> }));
import { addDays, DEFAULT_TERM_DAYS, InvoicesTab } from "./InvoicesTab";
import { OwnerContext } from "../../lib/auth";
const policy = { id: "p1", accountId: "a1", policyNumber: "POL-1", billType: "AGENCY", premium: 100, status: "ACTIVE" };
beforeEach(() => {
  vi.resetAllMocks();
  api.models.Invoice.list.mockResolvedValue({ data: [] });
  api.models.InvoiceLine.list.mockResolvedValue({ data: [] });
  api.models.Policy.list.mockResolvedValue({ data: [policy] });
  api.models.Quote.list.mockResolvedValue({ data: [] });
  api.models.Contact.list.mockResolvedValue({ data: [] });
  api.models.Account.get.mockResolvedValue({ data: { id: "a1" } });
  api.mutations.reserveInvoiceNumber.mockResolvedValue({ data: { invoiceNumber: "INV-1" } });
  api.models.Invoice.create.mockResolvedValue({ data: { id: "inv1", accountId: "a1", policyId: "p1", status: "DRAFT", number: "INV-1" } });
  api.models.InvoiceLine.create.mockResolvedValue({ data: { id: "line1" } });
});
async function selectPolicy() {
  render(<InvoicesTab accountId="a1" />);
  await userEvent.selectOptions(await screen.findByRole("combobox"), "policy:p1");
}

describe("combined invoice drafts", () => {
  const term = { effectiveDate: "2026-11-01", expirationDate: "2027-11-01" };
  const preparedPolicy = (id: string) => ({ ...policy, ...term, id, policyNumber: `POL-${id}`, lines: ["Commercial Property"] });
  const preparedDraft = (id: string) => ({ id: `draft-${id}`, accountId: "a1", policyId: id,
    status: "DRAFT", sourcePricingVersion: 1, number: `INV-${id}` });
  const preparedLine = (id: string) => ({ id: `premium-${id}`, invoiceId: `draft-${id}`, accountId: "a1",
    policyId: id, kind: "PREMIUM", retailAmount: 100, costAmount: 80 });
  const travelers = { ...preparedPolicy("travelers"), policyNumber: "TRAVELERS", carrierBillType: "DIRECT", premium: 200 };
  const renderOwner = () => render(<OwnerContext.Provider value={true}><InvoicesTab accountId="a1" /></OwnerContext.Provider>);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T15:00:00Z"));
  });
  afterEach(() => { vi.useRealTimers(); });

  it("combines three reviewed drafts and the carrier advance through one mutation", async () => {
    const ids = ["p1", "p2", "p3"];
    const drafts = ids.map(preparedDraft);
    const members = [...ids.map(preparedPolicy), travelers];
    api.models.Policy.list.mockResolvedValue({ data: members });
    api.models.InvoiceLine.list.mockResolvedValue({ data: ids.map(preparedLine) });
    api.models.Invoice.list.mockResolvedValueOnce({ data: drafts }).mockResolvedValue({ data: [
      ...drafts.map(draft => ({ ...draft, status: "VOID" })),
      { id: "grouped", accountId: "a1", status: "DRAFT", number: "INV-GROUP", sourcePricingVersion: 3, groupedPolicyIds: members.map(member => member.id) },
    ] });
    api.mutations.createGroupedInvoice.mockResolvedValue({ data: JSON.stringify({ ok: true, invoiceId: "grouped" }) });

    renderOwner();
    const combine = await screen.findByRole("button", { name: "Combine policies" });
    expect(screen.queryByRole("option", { name: /TRAVELERS/ })).not.toBeInTheDocument();
    await userEvent.click(combine);
    const create = screen.getByRole("button", { name: "Create combined draft" });
    expect(create).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /POL-p1.*Draft INV-p1.*\$100\.00/ })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /TRAVELERS.*HOA carrier advance.*\$200\.00/ })).toBeInTheDocument();
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(4);
    for (const box of checkboxes) await userEvent.click(box);
    await userEvent.click(create);

    expect(await screen.findByText("Editing grouped")).toBeInTheDocument();
    expect(api.mutations.createGroupedInvoice).toHaveBeenCalledExactlyOnceWith({ accountId: "a1", policyIds: [...ids, "travelers"] });
    expect(api.mutations.reserveInvoiceNumber).not.toHaveBeenCalled();
    expect(api.models.Invoice.create).not.toHaveBeenCalled();
    expect(api.models.InvoiceLine.create).not.toHaveBeenCalled();
    expect(screen.queryByRole("option", { name: /POL-p[123]/ })).not.toBeInTheDocument();
  });

  it("offers only prepared, unissued and ungrouped policy drafts to the owner", async () => {
    const ids = ["ready", "sent", "paid", "adjustment", "unreviewed", "grouped", "missing-draft", "different-term"];
    api.models.Policy.list.mockResolvedValue({ data: [travelers, ...ids.map(id => ({ ...preparedPolicy(id),
      ...(id === "different-term" ? { effectiveDate: "2026-10-01" } : {}),
    }))] });
    api.models.Invoice.list.mockResolvedValue({ data: [
      preparedDraft("ready"), { ...preparedDraft("sent"), status: "SENT" }, { ...preparedDraft("paid"), status: "PAID" },
      { ...preparedDraft("adjustment"), sourcePricingVersion: 2 }, preparedDraft("unreviewed"),
      { ...preparedDraft("grouped"), id: "bundle", policyId: null, sourcePricingVersion: 3, groupedPolicyIds: ["grouped", "another"] },
      preparedDraft("different-term"),
    ] });
    api.models.InvoiceLine.list.mockResolvedValue({ data: ids.filter(id => id !== "grouped").map(id => ({ ...preparedLine(id),
      ...(id === "unreviewed" ? { costAmount: null } : {}),
    })) });
    renderOwner();
    await userEvent.click(await screen.findByRole("button", { name: "Combine policies" }));
    for (const id of ["sent", "paid", "adjustment", "unreviewed", "grouped", "missing-draft"]) {
      expect(screen.queryByRole("checkbox", { name: new RegExp(`POL-${id}`) })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("option", { name: /POL-grouped/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: /POL-ready/ }));
    expect(screen.getByRole("checkbox", { name: /POL-different-term/ })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /TRAVELERS/ })).toBeEnabled();
  });

  it("leaves the combine action to the owner", async () => {
    api.models.Policy.list.mockResolvedValue({ data: [preparedPolicy("ready"), travelers] });
    api.models.Invoice.list.mockResolvedValue({ data: [preparedDraft("ready")] });
    api.models.InvoiceLine.list.mockResolvedValue({ data: [preparedLine("ready")] });
    render(<InvoicesTab accountId="a1" />);
    await screen.findByRole("combobox");
    expect(screen.queryByRole("button", { name: "Combine policies" })).not.toBeInTheDocument();
  });
});
describe("invoice creation reliability", () => {
  it("does not create an unnumbered invoice when reservation fails", async () => {
    api.mutations.reserveInvoiceNumber.mockResolvedValue({ data: null, errors: [{ message: "Reservation failed" }] });
    await selectPolicy();
    await userEvent.click(screen.getByRole("button", { name: "New invoice" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Reservation failed");
    expect(api.models.Invoice.create).not.toHaveBeenCalled();
  });
  it("keeps a created invoice visible and removes its anchor after premium-line failure", async () => {
    api.models.InvoiceLine.create.mockResolvedValue({ data: null, errors: [{ message: "Line failed" }] });
    await selectPolicy();
    await userEvent.click(screen.getByRole("button", { name: "New invoice" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invoice created, but its premium line couldn't be added");
    expect(screen.getByText("Editing inv1")).toBeInTheDocument();
    expect(screen.getByText("INV-1")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "POL-1" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New invoice" })).toBeDisabled();
  });
  it("prevents duplicate reservation and creation within one render", async () => {
    let finish!: (value: unknown) => void;
    api.mutations.reserveInvoiceNumber.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await selectPolicy();
    const button = screen.getByRole("button", { name: "New invoice" });
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    expect(api.mutations.reserveInvoiceNumber).toHaveBeenCalledTimes(1);
    await act(async () => finish({ data: { invoiceNumber: "INV-1" } }));
    await waitFor(() => expect(api.models.Invoice.create).toHaveBeenCalledTimes(1));
  });
  it("waits for premium seeding before mounting the invoice editor", async () => {
    let finish!: (value: unknown) => void;
    api.models.InvoiceLine.create.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await selectPolicy();
    await userEvent.click(screen.getByRole("button", { name: "New invoice" }));
    expect(await screen.findByText("INV-1")).toBeInTheDocument();
    expect(screen.queryByText("Editing inv1")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open" })).toBeDisabled();
    await act(async () => finish({ data: { id: "line1", invoiceId: "inv1" } }));
    expect(await screen.findByText("Editing inv1")).toBeInTheDocument();
  });
  it("explains the committed invoice when the seed request rejects", async () => {
    api.models.InvoiceLine.create.mockRejectedValueOnce(new Error("Network unavailable"));
    await selectPolicy();
    await userEvent.click(screen.getByRole("button", { name: "New invoice" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invoice created, but its premium line couldn't be added");
    expect(screen.getByText("Editing inv1")).toBeInTheDocument();
    expect(api.models.Invoice.create).toHaveBeenCalledTimes(1);
  });
  it("surfaces account read errors with a usable retry", async () => {
    api.models.Account.get.mockResolvedValueOnce({ data: null, errors: [{ message: "Account unavailable" }] });
    render(<InvoicesTab accountId="a1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Retry invoices" }));
    expect(await screen.findByRole("combobox")).toBeInTheDocument();
  });
});

describe("broker fee invoice seeding",()=>{
  it("does not offer direct-bill policies for collecting an HOA fee",async()=>{
    api.models.Policy.list.mockResolvedValue({data:[{...policy,quoteId:"q1",billType:"DIRECT",brokerFee:500}]});
    render(<InvoicesTab accountId="a1" />);
    await screen.findByRole('combobox');
    expect(screen.queryByRole('option', { name: /POL-1/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New invoice' })).toBeDisabled();
    expect(api.models.Invoice.create).not.toHaveBeenCalled();
  });
  it("does not seed the same fee onto a later premium invoice after collection",async()=>{
    api.models.Policy.list.mockResolvedValue({data:[{...policy,quoteId:"q1",brokerFee:500,brokerFeeCollected:500}]});
    await selectPolicy();
    await userEvent.click(screen.getByRole("button",{name:"New invoice"}));
    await screen.findByText("Editing inv1");
    expect(api.models.InvoiceLine.create).toHaveBeenCalledTimes(1);
    expect(api.models.InvoiceLine.create).toHaveBeenCalledWith(expect.objectContaining({kind:"PREMIUM"}));
  });
});

it("rejects a legacy direct-bill fee quote before reserving or creating an invoice",async()=>{
  api.models.Policy.list.mockResolvedValue({data:[]});
  api.models.Quote.list.mockResolvedValue({data:[{id:"q1",accountId:"a1",status:"QUOTED",billType:"DIRECT",premium:100,brokerFee:500}]});
  api.models.Invoice.create.mockResolvedValue({data:{id:"inv1",accountId:"a1",quoteId:"q1",status:"DRAFT",number:"INV-1"}});
  render(<InvoicesTab accountId="a1" />);
  await userEvent.selectOptions(await screen.findByRole("combobox"),"quote:q1");
  await userEvent.click(screen.getByRole("button",{name:"New invoice"}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Broker fees require agency billing');
  expect(api.mutations.reserveInvoiceNumber).not.toHaveBeenCalled();
  expect(api.models.Invoice.create).not.toHaveBeenCalled();
});

it.each([0, 500])('seeds every supplier charge and tax alongside a $%s HOA broker fee', async brokerFee => {
  api.models.Policy.list.mockResolvedValue({ data: [{ ...policy, premium: 55541, quoteId: 'q1', brokerFee, passThroughCharges: JSON.stringify([
    { id: 'rt', kind: 'WHOLESALER_FEE', description: 'RT brokerage fee', amountCents: 25000 },
    { id: 'tax', kind: 'SURPLUS_LINES', description: 'MA surplus lines tax', amountCents: 222164 },
  ]) }] });
  await selectPolicy(); await userEvent.click(screen.getByRole('button', { name: 'New invoice' }));
  await screen.findByText('Editing inv1');
  const rows = api.models.InvoiceLine.create.mock.calls.map(([row]) => row);
  const invoice = api.models.Invoice.create.mock.calls[0][0];
  expect(invoice.dueAt).toBe(brokerFee ? invoice.issuedAt : addDays(invoice.issuedAt, DEFAULT_TERM_DAYS));
  expect(rows).toEqual([
    expect.objectContaining({ kind: 'PREMIUM', retailAmount: 55541, costAmount: null }),
    expect.objectContaining({ kind: 'WHOLESALER_FEE', sourceQuoteChargeId: 'rt', retailAmount: 250, costAmount: 250 }),
    expect.objectContaining({ kind: 'SURPLUS_LINES', sourceQuoteChargeId: 'tax', retailAmount: 2221.64, costAmount: 2221.64 }),
    ...(brokerFee ? [expect.objectContaining({ kind: 'BROKER_FEE', description: 'HOA broker fee', retailAmount: brokerFee, costAmount: 0 })] : []),
  ]);
});

it.each(['ACTIVE', 'EXPIRED', 'CANCELLED'])('creates only an adjustment after a paid full-policy invoice on an %s policy', async status => {
  const source = { ...policy, status, premium: 55541, quoteId: 'q1', brokerFee: 500, brokerFeeCollected: 500, passThroughCharges: JSON.stringify([
    { id: 'rt', kind: 'WHOLESALER_FEE', description: 'Wholesale fee', amountCents: 25000 },
    { id: 'tax', kind: 'SURPLUS_LINES', description: 'Surplus tax', amountCents: 222164 },
  ]) };
  api.models.Policy.list.mockResolvedValue({ data: [source] });
  api.models.Invoice.list.mockResolvedValue({ data: [{ id: 'original', accountId: 'a1', quoteId: 'q1', status: 'PAID', sourcePricingVersion: 1 }] });
  api.models.InvoiceLine.list.mockResolvedValue({ data: [
    { id: 'original-premium', invoiceId: 'original', accountId: 'a1', kind: 'PREMIUM', retailAmount: 55541, costAmount: 49986.90 },
    { id: 'original-fee', invoiceId: 'original', accountId: 'a1', kind: 'BROKER_FEE', brokerFeeQuoteId: 'q1', retailAmount: 500, costAmount: 0 },
    { id: 'original-tax', invoiceId: 'original', accountId: 'a1', kind: 'SURPLUS_LINES', retailAmount: 2221.64, costAmount: 2221.64 },
  ] });
  await selectPolicy();
  expect(screen.getByRole('option', { name: /POL-1.*endorsement\/audit adjustment/ })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'New invoice' }));
  await screen.findByText('Editing inv1');
  expect(api.models.Invoice.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sourcePricingVersion: 2, policyId: 'p1', adjustsInvoiceId: 'original', adjustsPremiumLineId: 'original-premium' }));
  expect(api.models.Invoice.create.mock.calls[0][0]).not.toHaveProperty('quoteId');
  const created = api.models.Invoice.create.mock.calls[0][0];
  expect(created.dueAt).toBe(addDays(created.issuedAt, DEFAULT_TERM_DAYS));
  expect(api.models.InvoiceLine.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'ENDORSEMENT', description: 'Endorsement or audit adjustment', retailAmount: null, costAmount: null, policyId: 'p1' }));
});

it.each([-10000, 0])('allows a later policy bill after a finalized sent adjustment statement totaling %s cents', async total => {
  api.models.Invoice.list.mockResolvedValue({ data: [
    { id: 'original', accountId: 'a1', policyId: 'p1', status: 'PAID', sourcePricingVersion: 1 },
    { id: 'statement', accountId: 'a1', policyId: 'p1', status: 'SENT', sourcePricingVersion: 2, sentAt: '2026-11-04T20:00:00Z',
      adjustsInvoiceId: 'original', adjustsPremiumLineId: 'original-premium', remittanceCarrierCents: total,
      remittanceCommissionCents: 0, remittanceInterestCents: 0, remittanceBrokerFeeCents: 0 },
  ] });
  api.models.InvoiceLine.list.mockResolvedValue({ data: [
    { id: 'original-premium', invoiceId: 'original', accountId: 'a1', policyId: 'p1', kind: 'PREMIUM', retailAmount: 100 },
    { id: 'credit', invoiceId: 'statement', accountId: 'a1', policyId: 'p1', kind: 'ENDORSEMENT', retailAmount: -100, costAmount: -100 },
    ...(total === 0 ? [{ id: 'offset', invoiceId: 'statement', accountId: 'a1', policyId: 'p1', kind: 'ENDORSEMENT', retailAmount: 100, costAmount: 100 }] : []),
  ] });
  await selectPolicy(); await userEvent.click(screen.getByRole('button', { name: 'New invoice' }));
  await screen.findByText('Editing inv1');
  expect(api.models.Invoice.create).toHaveBeenCalledWith(expect.objectContaining({ sourcePricingVersion: 2, adjustsInvoiceId: 'original', adjustsPremiumLineId: 'original-premium' }));
  expect(api.models.InvoiceLine.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'ENDORSEMENT', retailAmount: null, costAmount: null }));
});
