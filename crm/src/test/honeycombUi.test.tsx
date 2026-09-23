import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import PriceIndication from "../../../web/src/components/quote/PriceIndication";
import QuoteConfirmation from "../../../web/src/components/quote/QuoteConfirmation";
import { buildCrmLead } from "../../../web/src/components/quote/submission";
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("keeps the saved receipt and document upload available through a pending decline", async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockResolvedValueOnce({ status: "pending" }).mockResolvedValue({ status: "unavailable" });
  render(<QuoteConfirmation uploadToken="fixture" estimate={<PriceIndication token="token" read={read} />} />);
  await act(async () => {});
  expect(screen.getByText(/Our team will be in touch within one business day/)).toBeTruthy();
  expect(screen.getByLabelText("Choose files")).not.toBeDisabled();
  expect(screen.getByRole("status").textContent).toContain("Checking");
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByText(/Our team will be in touch within one business day/)).toBeTruthy();
  expect(screen.getByLabelText("Choose files")).not.toBeDisabled();
});
it.each(["unavailable", "declined", "error"])("keeps %s results invisible to the visitor", async status => {
  const read = vi.fn().mockResolvedValue({ status, price: 1234, reason: "Honeycomb does not cover your state" });
  const view = render(<PriceIndication token="token" read={read} />);
  await act(async () => {}); expect(view.container.textContent).toBe("");
});
it("reveals only an eligible price after polling and stops on unmount", async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockResolvedValueOnce({ status: "pending" }).mockResolvedValue({ status: "ready", price: 1234, currency: "USD", staging: true });
  const view = render(<PriceIndication token="token" read={read} />);
  await act(async () => {});
  expect(screen.getByRole("status").textContent).toContain("Checking for an initial estimate");
  expect(screen.getByText(/Your request is saved/)).toBeTruthy();
  expect(view.container.textContent).not.toContain("Honeycomb");
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(screen.getByText("$1,234")).toBeTruthy(); expect(screen.getByText(/Staging test/)).toBeTruthy();
  view.unmount(); await vi.advanceTimersByTimeAsync(90000); expect(read).toHaveBeenCalledTimes(2);
});

it("shows no loading state or request without an estimate token", () => {
  const read = vi.fn();
  const view = render(<PriceIndication read={read} />);
  expect(view.container.textContent).toBe("");
  expect(read).not.toHaveBeenCalled();
});

it("clears loading and aborts a hung request at the deadline, ignoring late prices", async () => {
  vi.useFakeTimers();
  let resolve!: (value: { status: string; price: number; currency: string }) => void;
  const read = vi.fn(() => new Promise<{ status: string; price: number; currency: string }>(r => { resolve = r; }));
  const view = render(<PriceIndication token="token" read={read} />);
  expect(screen.getByRole("status").textContent).toContain("Checking");
  await act(async () => { await vi.advanceTimersByTimeAsync(90000); });
  expect(view.container.textContent).toBe("");
  expect((read.mock.calls[0] as unknown as [string, AbortSignal])[1].aborted).toBe(true);
  await act(async () => { resolve({ status: "ready", price: 9999, currency: "USD" }); });
  expect(view.container.textContent).toBe("");
});

it("cancels pending work on unmount", async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockResolvedValue({ status: "pending" });
  const view = render(<PriceIndication token="token" read={read} />);
  await act(async () => {});
  view.unmount();
  await vi.advanceTimersByTimeAsync(90000);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0][1].aborted).toBe(true);
});

it("does not retain a previous receipt's price when the token changes", async () => {
  const read = vi.fn().mockResolvedValueOnce({ status: "ready", price: 1234, currency: "USD" })
    .mockResolvedValue({ status: "pending" });
  const view = render(<PriceIndication token="first" read={read} />);
  await act(async () => {});
  expect(screen.getByText("$1,234")).toBeTruthy();
  view.rerender(<PriceIndication token="second" read={read} />);
  expect(screen.queryByText("$1,234")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("Checking");
  await act(async () => {});
});

it.each([0, -1, NaN, Infinity, "1234"])("hides invalid ready prices (%s)", async price => {
  const view = render(<PriceIndication token="token" read={vi.fn().mockResolvedValue({ status: "ready", price, currency: "USD" })} />);
  await act(async () => {});
  expect(view.container.textContent).toBe("");
});
it("leaves the saved-lead confirmation alone on network failure or deadline", async () => {
  vi.useFakeTimers(); const read = vi.fn().mockResolvedValue({ status: "pending" });
  const view = render(<PriceIndication token="token" read={read} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(95000); });
  const count = read.mock.calls.length; await vi.advanceTimersByTimeAsync(30000);
  expect(read).toHaveBeenCalledTimes(count); expect(view.container.textContent).toBe("");
  view.unmount();
  const failed = render(<PriceIndication token="token" read={vi.fn().mockRejectedValue(new Error("Carrier timeout"))} />);
  await act(async () => {}); expect(failed.container.textContent).toBe("");
});
it("preserves supplied property inputs and never routes HO-6 as an association", () => {
  const details = { associationName: "Example", propertyKind: "condominium", grossSquareFeet: "12000", replacementValue: "2500000" };
  expect(buildCrmLead({ ...details, role: "board" }, "Brian")).toMatchObject({ type: "ASSOCIATION", grossSquareFeet: "12000", replacementValue: "2500000", propertyKind: "condominium" });
  expect(buildCrmLead({ ...details, role: "owner" }, "Brian").grossSquareFeet).toBeUndefined();
});

it.each([25000, 45000, 60000])("accepts an estimate after %i ms without holding up the receipt", async delay => {
  vi.useFakeTimers(); const start = Date.now();
  const read = vi.fn(async () => Date.now()-start < delay ? { status: "pending" } : { status: "ready", price: 4321, currency: "USD" });
  const view = render(<PriceIndication token="token" read={read} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(delay + 3000); });
  expect(screen.getByText("$4,321")).toBeTruthy(); view.unmount();
});
