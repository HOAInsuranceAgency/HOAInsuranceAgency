import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ models: { PfCounselOpinion: { list: vi.fn() }, PfLoan: { list: vi.fn() } } }));
vi.mock("aws-amplify/data", () => ({ generateClient: () => api }));
vi.mock("../lib/premiumFinance/gate", () => ({
  jurisdictionFor: () => ({ code: "MA", status: "conditional" }),
  hasCurrentOpinion: (rows: unknown[]) => rows.length > 0,
  originationGate: (_: string, options: { hasCurrentCounselOpinion: boolean }) => options.hasCurrentCounselOpinion
    ? { open: true, jurisdiction: { name: "Massachusetts" } } : { open: false, reason: "No current opinion" },
  aprCapViolation: () => null, minPrincipalViolation: () => null,
}));
vi.mock("../lib/premiumFinance/eligibility", () => ({ evaluateEligibility: () => [] }));
import { FinanceOfferHint } from "./FinanceOfferHint";
import type { Account } from "../lib/client";
const props = { account: { id: "a1", state: "MA" } as Account, anchor: { id: "p1", kind: "policy" as const, lines: [] }, retailTotal: 1000 };
beforeEach(() => { vi.resetAllMocks(); api.models.PfLoan.list.mockResolvedValue({ data: [] }); });
it("reads later counsel opinion pages before deciding whether financing is available", async () => {
  api.models.PfCounselOpinion.list.mockResolvedValueOnce({ data: [], nextToken: "next" })
    .mockResolvedValueOnce({ data: [{ effectiveAt: "2026-01-01", reviewBy: "2027-01-01" }] });
  render(<FinanceOfferHint {...props} />);
  expect(await screen.findByText("Financing will be offered")).toBeInTheDocument();
  expect(api.models.PfCounselOpinion.list).toHaveBeenLastCalledWith(expect.objectContaining({ nextToken: "next" }));
});
it("shows failed checks as errors with retry instead of a false financing decision", async () => {
  api.models.PfCounselOpinion.list.mockResolvedValueOnce({ data: [], errors: [{ message: "Opinion check failed" }] })
    .mockResolvedValueOnce({ data: [{ effectiveAt: "2026-01-01" }] });
  render(<FinanceOfferHint {...props} />);
  expect(await screen.findByText(/Opinion check failed/)).toBeInTheDocument();
  expect(screen.queryByText("Financing won't be offered with this email")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Retry financing check" }));
  expect(await screen.findByText("Financing will be offered")).toBeInTheDocument();
});
