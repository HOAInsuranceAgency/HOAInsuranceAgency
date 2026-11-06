import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { Contact, Invoice, InvoiceLine } from "../lib/client";
const h = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn(), lineUpdate: vi.fn(), lineCreate: vi.fn(), lineDelete: vi.fn(), sourceGet: vi.fn(), get: vi.fn(), send: vi.fn(), voidInvoice: vi.fn(), change: vi.fn(), linesChange: vi.fn(), feeAction: vi.fn(), financeHint: vi.fn() }));
vi.mock("../lib/client", () => ({
  client: { models: {
    Invoice: { update: h.update, get: h.get, delete: vi.fn() },
    InvoiceLine: { list: h.list, update: h.lineUpdate, create: h.lineCreate, delete: h.lineDelete },
    Policy: { get: h.sourceGet }, Quote: { get: h.sourceGet },
  }, mutations: { sendInvoice: h.send, voidInvoice: h.voidInvoice, brokerFeeAction: h.feeAction } },
  friendlyError: (e: unknown, fallback: string) => e instanceof Error ? e.message || fallback : fallback,
}));
vi.mock("./FinanceOfferHint", () => ({ FinanceOfferHint: h.financeHint }));
import InvoiceEditor from "./InvoiceEditor";
const initial = { id: "inv-1", accountId: "a1", number: "INV-1", status: "DRAFT", issuedAt: "2026-10-01", dueAt: "2026-10-15", memo: "Original memo" } as Invoice;
const line = { id: "line-1", invoiceId: initial.id, accountId: "a1", kind: "PREMIUM", description: "Premium", retailAmount: 100, costAmount: 80, sortOrder: 0 } as InvoiceLine;
const contacts = [{ id: "c1", accountId: "a1", name: "Primary", email: "primary@example.com", isPrimary: true }, { id: "c2", accountId: "a1", name: "Treasurer", email: "treasurer@example.com" }] as Contact[];
let stored: Invoice;
let storedLine: InvoiceLine;
function Harness() {
  const [invoice, setInvoice] = useState(initial);
  return <InvoiceEditor invoice={invoice} policies={[]} quotes={[]} account={null} contacts={contacts} onChange={next => { h.change(next); setInvoice(next); }} onLinesChange={h.linesChange} onDeleted={vi.fn()} />;
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  vi.resetAllMocks(); stored = { ...initial }; storedLine = { ...line };
  h.financeHint.mockReturnValue(null);
  h.list.mockResolvedValue({ data: [line] });
  h.update.mockImplementation(async patch => { stored = { ...stored, ...patch }; return { data: { ...stored } }; });
  h.lineUpdate.mockImplementation(async patch => { storedLine = { ...storedLine, ...patch }; return { data: { ...storedLine } }; });
  h.get.mockImplementation(async () => ({ data: { ...stored } }));
  h.send.mockResolvedValue({ data: { ok: true, sentTo: "primary@example.com" } });
  h.voidInvoice.mockResolvedValue({ data: { ok: true } });
  h.feeAction.mockImplementation(async () => { stored = {...stored,status:"PAID"}; return {data:{ok:true}}; });
});
it("serializes independent blur saves and preserves a newer edit while the first request is pending", async () => {
  const first = deferred();
  h.update.mockImplementationOnce(async patch => { await first.promise; stored = { ...stored, ...patch }; return { data: { ...stored } }; });
  render(<Harness />);
  const memo = await screen.findByLabelText("Memo");
  fireEvent.change(memo, { target: { value: "First edit" } }); fireEvent.blur(memo);
  await waitFor(() => expect(h.update).toHaveBeenCalledTimes(1));
  fireEvent.change(memo, { target: { value: "Newer edit" } }); fireEvent.blur(memo);
  fireEvent.change(screen.getByLabelText("Due"), { target: { value: "2026-11-01" } }); fireEvent.blur(screen.getByLabelText("Due"));
  expect(h.update).toHaveBeenCalledTimes(1);
  expect(memo).toHaveValue("Newer edit");
  await act(async () => first.resolve());
  await waitFor(() => expect(stored).toMatchObject({ memo: "Newer edit", dueAt: "2026-11-01" }));
  expect(memo).toHaveValue("Newer edit");
  expect(h.update).toHaveBeenCalledTimes(2);
});
it("retains failed line edits and refuses to send until those edits can be saved", async () => {
  h.lineUpdate.mockResolvedValue({ data: null, errors: [{ message: "Line write unavailable" }] });
  render(<Harness />);
  const description = await screen.findByLabelText("Description");
  fireEvent.change(description, { target: { value: "Corrected premium" } });
  fireEvent.click(screen.getByRole("button", { name: "Send invoice" }));
  await screen.findByText("Line write unavailable");
  expect(description).toHaveValue("Corrected premium");
  expect(h.send).not.toHaveBeenCalled();
  h.lineUpdate.mockImplementation(async patch => { storedLine = { ...storedLine, ...patch }; return { data: { ...storedLine } }; });
  fireEvent.click(screen.getByRole("button", { name: "Send invoice" }));
  await waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
  expect(storedLine.description).toBe("Corrected premium");
});
it("saves the focused field before sending and locks the submitted recipients", async () => {
  const user = userEvent.setup(), save = deferred(), sending = deferred();
  h.update.mockImplementationOnce(async patch => { await save.promise; stored = { ...stored, ...patch }; return { data: { ...stored } }; });
  h.send.mockImplementation(async () => { expect(stored.memo).toBe("Ready to send"); await sending.promise; return { data: { ok: true, sentTo: "primary@example.com" } }; });
  render(<Harness />);
  const memo = await screen.findByLabelText("Memo");
  await user.clear(memo); await user.type(memo, "Ready to send");
  await user.click(screen.getByRole("button", { name: "Send invoice" }));
  await waitFor(() => expect(h.update).toHaveBeenCalledTimes(1));
  expect(h.send).not.toHaveBeenCalled();
  await act(async () => save.resolve());
  await waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
  for (const checkbox of screen.getAllByRole("checkbox")) expect(checkbox).toBeDisabled();
  await act(async () => sending.resolve());
  expect(h.send).toHaveBeenCalledWith({ invoiceId: initial.id, toEmail: "primary@example.com", expectedSentAt: "" });
});
it.each(["12.50", "-12.50"])("preserves money typing %s and saves the intended amount", async value => {
  const user = userEvent.setup(); render(<Harness />);
  const amount = await screen.findByLabelText("Bills the association");
  await user.clear(amount); await user.type(amount, value);
  expect(amount).toHaveValue(value);
  await user.tab();
  await waitFor(() => expect(h.lineUpdate).toHaveBeenCalledWith({ id: line.id, retailAmount: Number(value) }));
  expect(storedLine.retailAmount).toBe(Number(value));
});
it("resets invoice drafts and recipient choices when switching invoices", async () => {
  const props = { policies: [], quotes: [], account: null, contacts, onChange: h.change, onLinesChange: h.linesChange, onDeleted: vi.fn() };
  const view = render(<InvoiceEditor invoice={initial} {...props} />);
  fireEvent.change(await screen.findByLabelText("Memo"), { target: { value: "Old draft" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /Treasurer/ }));
  view.rerender(<InvoiceEditor invoice={{ ...initial, id: "inv-2", memo: "Other invoice" }} {...props} />);
  expect(await screen.findByLabelText("Memo")).toHaveValue("Other invoice");
  expect(screen.getByRole("checkbox", { name: /Primary/ })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: /Treasurer/ })).not.toBeChecked();
});
it("reports a committed send even when its refresh fails and keeps acknowledged edits", async () => {
  h.get.mockRejectedValue(new Error("Refresh unavailable"));
  render(<Harness />);
  fireEvent.change(await screen.findByLabelText("Memo"), { target: { value: "Latest saved memo" } });
  fireEvent.click(screen.getByRole("button", { name: "Send invoice" }));
  await screen.findByText(/Sent to primary@example.com.*Reopen the invoice/);
  expect(h.send).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("Memo")).toHaveValue("Latest saved memo");
  expect(screen.getByRole("button", { name: "Send again" })).toBeEnabled();
  expect(h.change).toHaveBeenLastCalledWith(expect.objectContaining({ memo: "Latest saved memo", sentTo: "primary@example.com", sentAt: expect.any(String) }));
});

it("does not lose confirmed send facts or saved drafts when the post-send read is stale", async () => {
  h.get.mockResolvedValue({ data: { ...initial } });
  render(<Harness />);
  fireEvent.change(await screen.findByLabelText("Memo"), { target: { value: "Acknowledged new memo" } });
  fireEvent.click(screen.getByRole("button", { name: "Send invoice" }));
  await screen.findByText(/Sent to primary@example.com.*Reopen the invoice/);
  expect(screen.getByRole("button", { name: "Send again" })).toBeEnabled();
  expect(screen.getByLabelText("Memo")).toHaveValue("Acknowledged new memo");
  expect(h.change).toHaveBeenLastCalledWith(expect.objectContaining({ memo: "Acknowledged new memo", sentTo: "primary@example.com", sentAt: expect.any(String) }));
});
it("keeps a confirmed void locked when a successful read returns the pre-void draft", async () => {
  h.get.mockResolvedValue({ data: { ...initial } });
  render(<Harness />);
  fireEvent.change(await screen.findByLabelText("Memo"), { target: { value: "Acknowledged before void" } });
  fireEvent.click(screen.getByRole("button", { name: "Void" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await screen.findByText(/Invoice voided.*Reopen it/);
  expect(screen.getByLabelText("Memo")).toHaveValue("Acknowledged before void");
  expect(screen.getByLabelText("Memo")).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Send invoice" })).toBeNull();
  expect(h.change).toHaveBeenLastCalledWith(expect.objectContaining({ status: "VOID", memo: "Acknowledged before void" }));
});
it("preserves a concurrently confirmed void when send metadata has not caught up", async () => {
  h.get.mockResolvedValue({ data: { ...initial, status: "VOID" } });
  render(<Harness />);
  fireEvent.change(await screen.findByLabelText("Memo"), { target: { value: "Saved before sending" } });
  fireEvent.click(screen.getByRole("button", { name: "Send invoice" }));
  await waitFor(() => expect(h.change).toHaveBeenLastCalledWith(expect.objectContaining({ status: "VOID" })));
  expect(screen.getByLabelText("Memo")).toBeDisabled();
  expect(screen.getByLabelText("Memo")).toHaveValue("Saved before sending");
  expect(h.change).toHaveBeenLastCalledWith(expect.objectContaining({ status: "VOID", memo: "Saved before sending", sentTo: "primary@example.com" }));
});

it("keeps the original send observation after a lost response even if a newer sentAt arrives", async () => {
  const props = { policies: [], quotes: [], account: null, contacts, onChange: h.change, onLinesChange: h.linesChange, onDeleted: vi.fn() };
  h.send.mockRejectedValueOnce(new Error("Connection lost"));
  const view = render(<InvoiceEditor invoice={initial} {...props} />);
  await screen.findByLabelText("Memo"); fireEvent.click(screen.getByRole("button", { name: "Send invoice" }));
  await screen.findByText("Connection lost");
  const acceptedAt = "2026-11-02T14:00:00.000Z";
  stored = { ...initial, status: "SENT", sentAt: acceptedAt, sentTo: "primary@example.com" };
  view.rerender(<InvoiceEditor invoice={stored} {...props} />);
  h.send.mockResolvedValueOnce({ data: { ok: true, sentTo: stored.sentTo, sentAt: acceptedAt } });
  fireEvent.click(screen.getByRole("button", { name: "Send again" }));
  await waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
  expect(h.send.mock.calls[1][0]).toMatchObject({ expectedSentAt: "", toEmail: "primary@example.com" });
  await screen.findByText("Sent to primary@example.com.");
  fireEvent.click(screen.getByRole("button", { name: "Send again" }));
  await waitFor(() => expect(h.send).toHaveBeenCalledTimes(3));
  expect(h.send.mock.calls[2][0]).toMatchObject({ expectedSentAt: acceptedAt });
});

it("refuses a changed recipient selection after a failed send instead of silently reusing the old address", async () => {
  h.send.mockRejectedValueOnce(new Error("Connection lost"));
  render(<Harness />);
  await screen.findByLabelText("Memo"); fireEvent.click(screen.getByRole("button", { name: "Send invoice" }));
  await screen.findByText("Connection lost");
  fireEvent.click(screen.getByRole("checkbox", { name: /Treasurer/ }));
  fireEvent.click(screen.getByRole("button", { name: "Send invoice" }));
  await screen.findByText(/previous send used different recipients/);
  expect(h.send).toHaveBeenCalledTimes(1);
});

it("confirms manual payment through the server fee ledger instead of directly changing invoice status", async () => {
  stored={...initial,status:"SENT"};
  render(<InvoiceEditor invoice={stored} policies={[]} quotes={[]} account={null} contacts={contacts} onChange={h.change} onLinesChange={h.linesChange} onDeleted={vi.fn()} />);
  await screen.findByLabelText("Description");
  await userEvent.click(screen.getByRole("button",{name:"Mark paid"}));
  await waitFor(()=>expect(h.change).toHaveBeenCalledWith(expect.objectContaining({status:"PAID"})));
  expect(h.feeAction).toHaveBeenCalledWith({input:JSON.stringify({op:"confirmInvoicePayment",invoiceId:initial.id})});
  expect(h.update).not.toHaveBeenCalled();
});
it("keeps the policy-sourced broker fee amount and kind read only", async () => {
  h.list.mockResolvedValue({data:[{...line,kind:"BROKER_FEE",brokerFeeQuoteId:"q1",description:"Broker fee",costAmount:0}]});
  render(<Harness />);
  expect(await screen.findByLabelText("Description")).toBeDisabled();
  expect(screen.getByLabelText("Kind")).toBeDisabled();
  expect(screen.getByLabelText("Bills the association")).toBeDisabled();
  expect(screen.getByLabelText("Costs the agency")).toBeDisabled();
  expect(screen.getByRole("button",{name:"Remove"})).toBeDisabled();
});

it('keeps source supplier charges locked at their recorded amount and cost', async () => {
  h.list.mockResolvedValue({ data: [{ ...line, kind: 'WHOLESALER_FEE', sourceQuoteChargeId: 'rt-fee', description: 'RT brokerage fee', retailAmount: 250, costAmount: 250 }] });
  render(<Harness />);
  expect(await screen.findByLabelText('Description')).toBeDisabled();
  expect(screen.getByLabelText('Kind')).toBeDisabled();
  expect(screen.getByLabelText('Bills the association')).toHaveValue('250');
  expect(screen.getByLabelText('Costs the agency')).toHaveValue('250');
  expect(screen.getByLabelText('Costs the agency')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
});

it('requires actual remittance cost before sending, while accepting a reviewed zero', async () => {
  h.list.mockResolvedValue({ data: [{ ...line, costAmount: null }] });
  storedLine = { ...line, costAmount: null };
  render(<Harness />);
  const cost = await screen.findByLabelText('Costs the agency');
  expect(screen.getByRole('button', { name: 'Send invoice' })).toBeDisabled();
  expect(screen.getByText(/Enter actual carrier\/wholesaler remittance cost in the cost cell/)).toBeVisible();
  fireEvent.change(cost, { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send invoice' }));
  await waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
  expect(storedLine.costAmount).toBe(0);
});

it('reconciles a partial draft from fresh source charges and preserves reviewed premium cost across retry', async () => {
  let rows = [line, { ...line, id: 'old-charge', kind: 'WHOLESALER_FEE', sourceQuoteChargeId: 'obsolete', retailAmount: 5, costAmount: 5 },
    { ...line, id: 'rt-line', kind: 'WHOLESALER_FEE', sourceQuoteChargeId: 'rt', description: 'Old RT fee', retailAmount: 200, costAmount: 200 }] as InvoiceLine[];
  h.list.mockImplementation(async () => ({ data: structuredClone(rows) }));
  h.sourceGet.mockResolvedValue({ data: { id: 'q', premium: 120, billType: 'AGENCY', lines: ['Property'], passThroughCharges: JSON.stringify([
    { id: 'rt', kind: 'WHOLESALER_FEE', description: 'RT brokerage fee', amountCents: 25000 },
    { id: 'tax', kind: 'SURPLUS_LINES', description: 'Surplus tax', amountCents: 1000 },
  ]) } });
  h.lineUpdate.mockImplementation(async patch => { rows = rows.map(row => row.id === patch.id ? { ...row, ...patch } : row); return { data: rows.find(row => row.id === patch.id) }; });
  h.lineDelete.mockImplementation(async ({ id }) => { rows = rows.filter(row => row.id !== id); return { data: { id } }; });
  h.lineCreate.mockResolvedValueOnce({ data: null, errors: [{ message: 'Temporary source-line failure' }] }).mockImplementation(async row => { rows.push(row); return { data: row }; });
  render(<InvoiceEditor invoice={{ ...initial, quoteId: 'q', sourcePricingVersion: 1 } as Invoice} policies={[]} quotes={[]} account={null} contacts={contacts} onChange={h.change} onLinesChange={h.linesChange} onDeleted={vi.fn()} />);
  expect(await screen.findByText('Temporary source-line failure')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Send invoice' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry invoice lines' }));
  expect(await screen.findByDisplayValue('Surplus tax')).toBeDisabled();
  expect(rows.find(row => row.id === line.id)).toMatchObject({ retailAmount: 120, costAmount: 80 });
  expect(rows.filter(row => row.sourceQuoteChargeId === 'rt')).toHaveLength(1);
  expect(rows.find(row => row.sourceQuoteChargeId === 'rt')).toMatchObject({ retailAmount: 250, costAmount: 250 });
  expect(rows.some(row => row.id === 'old-charge')).toBe(false);
  expect(h.lineCreate.mock.calls.every(([row]) => row.id === 'invoice:inv-1:charge:tax')).toBe(true);
  const premiumRow = screen.getByDisplayValue('Property — quoted coverage').closest('tr')!;
  expect(premiumRow.querySelector('input[aria-label="Bills the association"]')).toBeDisabled();
  expect(premiumRow.querySelector('input[aria-label="Costs the agency"]')).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Add line at the end' })).not.toBeInTheDocument();
  expect(h.linesChange).toHaveBeenLastCalledWith(initial.id, expect.arrayContaining([expect.objectContaining({ sourceQuoteChargeId: 'tax', retailAmount: 10, costAmount: 10 })]));
});

it.each([{ status: 'SENT', sourcePricingVersion: 1 }, { status: 'DRAFT', stripePaymentLinkId: 'pl-issued', sourcePricingVersion: 1 },
  { status: 'SENT', sourcePricingVersion: 2 }, { status: 'DRAFT', stripePaymentLinkId: 'pl-issued', sourcePricingVersion: 2 }])('preserves issued source-priced lines for $status version$sourcePricingVersion invoices', async state => {
  render(<InvoiceEditor invoice={{ ...initial, ...state, quoteId: 'q' } as Invoice} policies={[]} quotes={[]} account={null} contacts={contacts} onChange={h.change} onLinesChange={h.linesChange} onDeleted={vi.fn()} />);
  expect(await screen.findByLabelText('Costs the agency')).toBeDisabled();
  expect(screen.getByText('Void this invoice before changing its charges.')).toBeVisible();
  expect(h.sourceGet).not.toHaveBeenCalled();
  expect(h.lineUpdate).not.toHaveBeenCalled();
});

it('edits only actual adjustment deltas and at-cost supplier amounts without refreshing original policy charges', async () => {
  let rows = [{ ...line, kind: 'ENDORSEMENT', description: 'Endorsement or audit adjustment', retailAmount: null, costAmount: null }] as InvoiceLine[];
  h.list.mockImplementation(async () => ({ data: structuredClone(rows) }));
  h.lineCreate.mockImplementation(async input => { const row = { ...input, id: `delta-${rows.length}` }; rows.push(row); return { data: row }; });
  h.lineUpdate.mockImplementation(async patch => { rows = rows.map(row => row.id === patch.id ? { ...row, ...patch } : row); return { data: rows.find(row => row.id === patch.id) }; });
  render(<InvoiceEditor invoice={{ ...initial, policyId: 'p', sourcePricingVersion: 2, adjustsInvoiceId: 'paid', adjustsPremiumLineId: 'paid-premium' } as Invoice}
    policies={[{ id: 'p', accountId: 'a1', premium: 55541, brokerFee: 500, billType: 'AGENCY', passThroughCharges: JSON.stringify([{ id: 'tax', kind: 'SURPLUS_LINES', description: 'Original tax', amountCents: 222164 }]) } as import('../lib/client').Policy]}
    quotes={[]} account={{ id: 'a1', state: 'MA' } as import('../lib/client').Account} contacts={contacts} onChange={h.change} onLinesChange={h.linesChange} onDeleted={vi.fn()} />);
  const amount = await screen.findByLabelText('Bills the association');
  expect(amount).toBeEnabled();
  expect(screen.getByLabelText('Kind')).toBeEnabled();
  expect(screen.getAllByRole('option').map(option => option.getAttribute('value'))).toEqual(['ENDORSEMENT', 'CARRIER_FEE', 'WHOLESALER_FEE', 'TAX', 'SURPLUS_LINES', 'STAMPING_FEE']);
  expect(screen.getByRole('button', { name: 'Send invoice' })).toBeDisabled();
  fireEvent.change(amount, { target: { value: '1000' } });
  fireEvent.change(screen.getByLabelText('Costs the agency'), { target: { value: '800' } });
  fireEvent.blur(screen.getByLabelText('Costs the agency'));
  await waitFor(() => expect(rows[0]).toMatchObject({ retailAmount: 1000, costAmount: 800 }));
  await userEvent.click(screen.getByRole('button', { name: 'Add adjustment line' }));
  await waitFor(() => expect(screen.getAllByLabelText('Description')).toHaveLength(2));
  const added = screen.getAllByLabelText('Description')[1].closest('tr')! as HTMLElement;
  await userEvent.selectOptions(within(added).getByLabelText('Kind'), 'TAX');
  fireEvent.change(within(added).getByLabelText('Bills the association'), { target: { value: '100' } });
  fireEvent.blur(within(added).getByLabelText('Bills the association'));
  await waitFor(() => expect(rows.find(row => row.kind === 'TAX')).toMatchObject({ retailAmount: 100, costAmount: 100 }));
  expect(within(added).getByLabelText('Costs the agency')).toBeDisabled();
  expect(screen.getByText('$1,100.00')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Send invoice' })).toBeEnabled();
  expect(h.sourceGet).not.toHaveBeenCalled();
  expect(h.feeAction).not.toHaveBeenCalled();
  expect(h.financeHint).not.toHaveBeenCalled();
  expect(rows.every(row => ['ENDORSEMENT', 'TAX'].includes(row.kind!))).toBe(true);
});

it('allows a signed credit adjustment with the matching actual supplier credit', async () => {
  h.list.mockResolvedValue({ data: [{ ...line, kind: 'ENDORSEMENT', description: 'Audit credit', retailAmount: -100, costAmount: -80 }] });
  render(<InvoiceEditor invoice={{ ...initial, policyId: 'p', sourcePricingVersion: 2 } as Invoice} policies={[]} quotes={[]} account={null} contacts={contacts} onChange={h.change} onLinesChange={h.linesChange} onDeleted={vi.fn()} />);
  expect(await screen.findByDisplayValue('Audit credit')).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Send invoice' })).toBeEnabled();
  expect(screen.getByText('-$100.00')).toBeVisible();
  expect(h.sourceGet).not.toHaveBeenCalled();
});

it('repairs a missing adjustment seed without loading or copying original premium or fees', async () => {
  h.list.mockResolvedValue({ data: [] });
  h.lineCreate.mockImplementation(async row => ({ data: row }));
  render(<InvoiceEditor invoice={{ ...initial, policyId: 'p', sourcePricingVersion: 2 } as Invoice} policies={[]} quotes={[]} account={null} contacts={contacts} onChange={h.change} onLinesChange={h.linesChange} onDeleted={vi.fn()} />);
  expect(await screen.findByLabelText('Description')).toHaveValue('Endorsement or audit adjustment');
  expect(h.lineCreate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'invoice:inv-1:adjustment', kind: 'ENDORSEMENT', retailAmount: null, costAmount: null }));
  expect(h.sourceGet).not.toHaveBeenCalled();
  expect(h.feeAction).not.toHaveBeenCalled();
});

it('opens and sends an unflagged legacy adjustment draft without replacing it with current full-term charges', async () => {
  const originalLines = [
    { ...line, kind: 'ENDORSEMENT', policyId: 'p', description: 'Existing endorsement', retailAmount: 1000, costAmount: 800 },
    { ...line, id: 'legacy-tax', kind: 'TAX', policyId: 'p', description: 'Existing tax adjustment', retailAmount: 40, costAmount: 40 },
  ];
  h.list.mockResolvedValue({ data: originalLines });
  h.sourceGet.mockResolvedValue({ data: { id: 'p', accountId: 'a1', premium: 55541, billType: 'AGENCY', brokerFee: 500, passThroughCharges: JSON.stringify([
    { id: 'whole-term-fee', kind: 'WHOLESALER_FEE', description: 'Current full-term supplier charge', amountCents: 25000 },
    { id: 'whole-term-tax', kind: 'SURPLUS_LINES', description: 'Current full-term tax', amountCents: 222164 },
  ]) } });
  render(<InvoiceEditor invoice={{ ...initial, policyId: 'p' } as Invoice}
    policies={[{ id: 'p', accountId: 'a1', premium: 55541, billType: 'AGENCY', brokerFee: 500 } as import('../lib/client').Policy]}
    quotes={[]} account={null} contacts={contacts} onChange={h.change} onLinesChange={h.linesChange} onDeleted={vi.fn()} />);
  expect(await screen.findByDisplayValue('Existing endorsement')).toBeEnabled();
  expect(screen.getByText('$1,040.00')).toBeVisible();
  expect(h.linesChange).toHaveBeenLastCalledWith(initial.id, originalLines);
  expect(h.sourceGet).not.toHaveBeenCalled();
  expect(h.lineCreate).not.toHaveBeenCalled();
  expect(h.lineUpdate).not.toHaveBeenCalled();
  expect(h.lineDelete).not.toHaveBeenCalled();
  expect(h.feeAction).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Send invoice' }));
  await waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
  expect(h.sourceGet).not.toHaveBeenCalled();
  expect(h.feeAction).not.toHaveBeenCalled();
  expect(h.lineCreate).not.toHaveBeenCalled();
  expect(h.lineUpdate).not.toHaveBeenCalled();
});

it.each([-100, 0])('does not offer an incoming cash receipt for a sent adjustment statement totaling $%s', async total => {
  h.list.mockResolvedValue({ data: [
    { ...line, kind: 'ENDORSEMENT', description: 'Audit credit', retailAmount: -100, costAmount: -80 },
    ...(total === 0 ? [{ ...line, id: 'offset', kind: 'ENDORSEMENT', description: 'Offsetting premium', retailAmount: 100, costAmount: 80 }] : []),
  ] });
  render(<InvoiceEditor invoice={{ ...initial, status: 'SENT', sentAt: '2026-11-04T20:00:00Z', policyId: 'p', sourcePricingVersion: 2,
    remittanceCarrierCents: total * 80, remittanceCommissionCents: total * 20, remittanceBrokerFeeCents: 0, remittanceInterestCents: 0 } as Invoice}
    policies={[]} quotes={[]} account={null} contacts={contacts} onChange={h.change} onLinesChange={h.linesChange} onDeleted={vi.fn()} />);
  await screen.findByDisplayValue('Audit credit');
  expect(screen.queryByRole('button', { name: 'Mark paid' })).not.toBeInTheDocument();
  expect(screen.getByText(/no incoming payment is due/)).toBeVisible();
  expect(screen.getByText('SENT')).toBeVisible();
  expect(h.feeAction).not.toHaveBeenCalled();
});

it.each([0, 50000])('repairs a missing HOA fee without charging a previously collected balance of %s cents again', async collectedCents => {
  h.list.mockResolvedValue({ data: [{ ...line, description: 'Quoted coverage' }] });
  h.sourceGet.mockResolvedValue({ data: { id: 'q', accountId: 'a1', premium: 100, billType: 'AGENCY', brokerFee: 500, passThroughCharges: '[]' } });
  h.feeAction.mockResolvedValue({ data: JSON.stringify({ ok: true, fees: [{ quoteId: 'q', amountCents: 50000, terms: 'current', submittedCents: collectedCents, refundedCents: 0, collectedCents }] }) });
  h.lineCreate.mockImplementation(async row => ({ data: row }));
  render(<InvoiceEditor invoice={{ ...initial, quoteId: 'q', sourcePricingVersion: 1 } as Invoice} policies={[]} quotes={[]} account={null} contacts={contacts} onChange={h.change} onLinesChange={h.linesChange} onDeleted={vi.fn()} />);
  await screen.findByRole('button', { name: 'Send invoice' });
  if (collectedCents) expect(h.lineCreate).not.toHaveBeenCalled();
  else expect(h.lineCreate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'invoice:inv-1:broker-fee', kind: 'BROKER_FEE', description: 'HOA broker fee', retailAmount: 500, costAmount: 0 }));
});

it.each([undefined, null])('allows actual supplier fees and tax at cost for a legacy policy with %s structured charges', async passThroughCharges => {
  let rows = [{ ...line, description: 'POL-OLD', policyId: 'p', retailAmount: 10000, costAmount: 9000 }] as InvoiceLine[];
  h.list.mockImplementation(async () => ({ data: structuredClone(rows) }));
  h.sourceGet.mockResolvedValue({ data: { id: 'p', accountId: 'a1', policyNumber: 'POL-OLD', premium: 10000, billType: 'AGENCY', passThroughCharges } });
  h.lineCreate.mockImplementation(async input => { const row = { ...input, id: `manual-${rows.length}` }; rows.push(row); return { data: row }; });
  h.lineUpdate.mockImplementation(async patch => { rows = rows.map(row => row.id === patch.id ? { ...row, ...patch } : row); return { data: rows.find(row => row.id === patch.id) }; });
  render(<InvoiceEditor invoice={{ ...initial, policyId: 'p', sourcePricingVersion: 1 } as Invoice} policies={[]} quotes={[]} account={null} contacts={contacts} onChange={h.change} onLinesChange={h.linesChange} onDeleted={vi.fn()} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Add supplier/tax line' }));
  let row = (await screen.findByDisplayValue('Supplier charge or tax')).closest('tr')! as HTMLElement;
  expect(screen.getByRole('button', { name: 'Send invoice' })).toBeDisabled();
  expect(screen.getByText(/Enter a positive supplier or tax amount in whole cents/)).toBeVisible();
  expect(within(row).getAllByRole('option').map(option => option.getAttribute('value'))).toEqual(['CARRIER_FEE', 'WHOLESALER_FEE', 'TAX', 'SURPLUS_LINES', 'STAMPING_FEE']);
  fireEvent.change(within(row).getByLabelText('Description'), { target: { value: 'Wholesale brokerage fee' } });
  await userEvent.selectOptions(within(row).getByLabelText('Kind'), 'WHOLESALER_FEE');
  fireEvent.change(within(row).getByLabelText('Bills the association'), { target: { value: '250' } });
  fireEvent.blur(within(row).getByLabelText('Bills the association'));
  await waitFor(() => expect(rows.find(line => line.kind === 'WHOLESALER_FEE')).toMatchObject({ retailAmount: 250, costAmount: 250 }));
  expect(within(row).getByLabelText('Costs the agency')).toBeDisabled();
  expect(within(row).getByLabelText('Costs the agency')).toHaveValue('250');
  await userEvent.click(screen.getByRole('button', { name: 'Add supplier/tax line' }));
  row = (await screen.findByDisplayValue('Supplier charge or tax')).closest('tr')! as HTMLElement;
  fireEvent.change(within(row).getByLabelText('Description'), { target: { value: 'Surplus tax' } });
  await userEvent.selectOptions(within(row).getByLabelText('Kind'), 'SURPLUS_LINES');
  fireEvent.change(within(row).getByLabelText('Bills the association'), { target: { value: '2000' } });
  fireEvent.blur(within(row).getByLabelText('Bills the association'));
  await waitFor(() => expect(rows.find(line => line.kind === 'SURPLUS_LINES')).toMatchObject({ retailAmount: 2000, costAmount: 2000 }));
  expect(screen.getByText('$12,250.00')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Send invoice' })).toBeEnabled();
  const premium = screen.getByDisplayValue('POL-OLD').closest('tr')! as HTMLElement;
  expect(within(premium).getByLabelText('Bills the association')).toBeDisabled();
  expect(within(premium).getByLabelText('Bills the association')).toHaveValue('10000');
  expect(within(premium).getByLabelText('Costs the agency')).toHaveValue('9000');
  expect(screen.getByText(/Each amount is billed at the same cost, with no agency markup/)).toBeVisible();
});

it.each([
  { anchor: { policyId: 'p' }, source: { id: 'p', passThroughCharges: '[]' } },
  { anchor: { quoteId: 'q' }, source: { id: 'q' } },
])('does not grant manual supplier pricing to structured policies or legacy quotes: $anchor', async ({ anchor, source }) => {
  h.sourceGet.mockResolvedValue({ data: { ...source, accountId: 'a1', premium: 100, billType: 'AGENCY' } });
  render(<InvoiceEditor invoice={{ ...initial, ...anchor, sourcePricingVersion: 1 } as Invoice} policies={[]} quotes={[]} account={null} contacts={contacts} onChange={h.change} onLinesChange={h.linesChange} onDeleted={vi.fn()} />);
  await screen.findByRole('button', { name: 'Send invoice' });
  expect(screen.queryByRole('button', { name: 'Add supplier/tax line' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Add line at the end' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Bills the association')).toBeDisabled();
});

it("keeps every issued fee invoice charge read only until the existing invoice is voided",async()=>{
 const issued={...initial,status:'SENT',brokerFeeAllocations:JSON.stringify([{quoteId:'q1',amountCents:50000}])} as Invoice;
 render(<InvoiceEditor invoice={issued} policies={[]} quotes={[]} account={null} contacts={contacts} onChange={h.change} onLinesChange={h.linesChange} onDeleted={vi.fn()} />);
 expect(await screen.findByLabelText('Bills the association')).toBeDisabled();
 expect(screen.getByLabelText('Costs the agency')).toBeDisabled();
 expect(screen.queryByRole('button',{name:'Add line at the end'})).not.toBeInTheDocument();
 expect(screen.getByText('Void this invoice before changing its charges.')).toBeInTheDocument();
});
