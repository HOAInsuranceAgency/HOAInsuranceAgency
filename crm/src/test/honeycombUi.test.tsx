import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import PriceIndication from "../../../web/src/components/quote/PriceIndication";
import { buildCrmLead } from "../../../web/src/components/quote/submission";
afterEach(() => { cleanup(); vi.useRealTimers(); });
it.each(["unavailable", "declined", "error"])("keeps %s results invisible to the visitor", async status => {
  const read = vi.fn().mockResolvedValue({ status, price: 1234, reason: "Honeycomb does not cover your state" });
  const view = render(<PriceIndication token="token" read={read} />);
  await act(async () => {}); expect(view.container.textContent).toBe("");
});
it("reveals only an eligible price after polling and stops on unmount", async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockResolvedValueOnce({ status: "pending" }).mockResolvedValue({ status: "ready", price: 1234, currency: "USD", staging: true });
  const view = render(<PriceIndication token="token" read={read} />);
  await act(async () => {}); expect(view.container.textContent).toBe("");
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(screen.getByText("$1,234")).toBeTruthy(); expect(screen.getByText(/Staging test/)).toBeTruthy();
  view.unmount(); await vi.advanceTimersByTimeAsync(90000); expect(read).toHaveBeenCalledTimes(2);
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
