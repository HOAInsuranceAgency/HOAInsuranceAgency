import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { Contact, Invoice, InvoiceLine } from "../lib/client";
const h = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn(), lineUpdate: vi.fn(), get: vi.fn(), send: vi.fn(), voidInvoice: vi.fn(), change: vi.fn(), linesChange: vi.fn() }));
vi.mock("../lib/client", () => ({
  client: { models: {
    Invoice: { update: h.update, get: h.get, delete: vi.fn() },
    InvoiceLine: { list: h.list, update: h.lineUpdate, create: vi.fn(), delete: vi.fn() },
  }, mutations: { sendInvoice: h.send, voidInvoice: h.voidInvoice } },
  friendlyError: (e: unknown, fallback: string) => e instanceof Error ? e.message || fallback : fallback,
}));
vi.mock("./FinanceOfferHint", () => ({ FinanceOfferHint: () => null }));
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
  h.list.mockResolvedValue({ data: [line] });
  h.update.mockImplementation(async patch => { stored = { ...stored, ...patch }; return { data: { ...stored } }; });
  h.lineUpdate.mockImplementation(async patch => { storedLine = { ...storedLine, ...patch }; return { data: { ...storedLine } }; });
  h.get.mockImplementation(async () => ({ data: { ...stored } }));
  h.send.mockResolvedValue({ data: { ok: true, sentTo: "primary@example.com" } });
  h.voidInvoice.mockResolvedValue({ data: { ok: true } });
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
  expect(h.send).toHaveBeenCalledWith({ invoiceId: initial.id, toEmail: "primary@example.com" });
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
