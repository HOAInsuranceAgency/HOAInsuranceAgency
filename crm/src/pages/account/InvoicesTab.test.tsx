import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  models: {
    Invoice: { list: vi.fn(), create: vi.fn() }, InvoiceLine: { list: vi.fn(), create: vi.fn() },
    Policy: { list: vi.fn() }, Quote: { list: vi.fn() }, Contact: { list: vi.fn() }, Account: { get: vi.fn() },
  },
  mutations: { reserveInvoiceNumber: vi.fn() },
}));
vi.mock("aws-amplify/data", () => ({ generateClient: () => api }));
vi.mock("../../components/InvoiceEditor", () => ({ InvoiceEditor: ({ invoice }: { invoice: { id: string } }) => <div>Editing {invoice.id}</div> }));
import { InvoicesTab } from "./InvoicesTab";
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
  it("seeds only the broker fee for a direct-bill policy",async()=>{
    api.models.Policy.list.mockResolvedValue({data:[{...policy,quoteId:"q1",billType:"DIRECT",brokerFee:500}]});
    await selectPolicy();
    await userEvent.click(screen.getByRole("button",{name:"New invoice"}));
    await screen.findByText("Editing inv1");
    expect(api.models.InvoiceLine.create).toHaveBeenCalledTimes(1);
    expect(api.models.InvoiceLine.create).toHaveBeenCalledWith(expect.objectContaining({kind:"BROKER_FEE",retailAmount:500,costAmount:0,brokerFeeQuoteId:"q1",policyId:"p1"}));
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

it("collects only the fee when direct bill is chosen on the existing quote before bind",async()=>{
  api.models.Policy.list.mockResolvedValue({data:[]});
  api.models.Quote.list.mockResolvedValue({data:[{id:"q1",accountId:"a1",status:"QUOTED",billType:"DIRECT",premium:100,brokerFee:500}]});
  api.models.Invoice.create.mockResolvedValue({data:{id:"inv1",accountId:"a1",quoteId:"q1",status:"DRAFT",number:"INV-1"}});
  render(<InvoicesTab accountId="a1" />);
  await userEvent.selectOptions(await screen.findByRole("combobox"),"quote:q1");
  await userEvent.click(screen.getByRole("button",{name:"New invoice"}));
  await screen.findByText("Editing inv1");
  expect(api.models.InvoiceLine.create).toHaveBeenCalledTimes(1);
  expect(api.models.InvoiceLine.create).toHaveBeenCalledWith(expect.objectContaining({kind:"BROKER_FEE",brokerFeeQuoteId:"q1",retailAmount:500,costAmount:0}));
});
