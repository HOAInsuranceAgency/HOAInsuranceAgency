import { beforeEach, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { commissionPolicy } from "../test/commissionFixtures";
const h = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock("../lib/commissions", () => ({ commissionAction: h.action }));
vi.mock("../lib/client", () => ({
  friendlyError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("../lib/editProtection", () => ({ useUnsavedChanges: vi.fn() }));
vi.mock("./ReportDownload", () => ({ ReportDownload: () => null }));
import CommissionExceptions from "./CommissionExceptions";
let data: any;
beforeEach(() => {
  vi.resetAllMocks();
  data = {
    policies: [commissionPolicy()],
    earnings: [],
    departures: [],
    adjustments: [],
    producers: [
      { id: "producer", name: "Avery" },
      { id: "jordan", name: "Jordan" },
    ],
  };
  h.action.mockImplementation(async (op: string) =>
    op === "commissionExceptions" ? structuredClone(data) : { ok: true },
  );
});
const open = async (title: string) => {
  const e = await screen.findByText(title);
  fireEvent.click(e);
  return within(e.closest("details")!);
};
it("approves explicitly reviewed percentage shares using cents-safe basis points", async () => {
  render(
    <CommissionExceptions refreshLedger={vi.fn()} onAccessDenied={vi.fn()} />,
  );
  const f = await open("Approve a policy commission allocation");
  fireEvent.change(f.getByLabelText("Allocation policy"), {
    target: { value: "p" },
  });
  fireEvent.change(f.getByLabelText("Apply to receipts from"), {
    target: { value: "2026-12-01" },
  });
  fireEvent.change(f.getByLabelText("Avery policy share (%)"), {
    target: { value: "60" },
  });
  fireEvent.change(f.getByLabelText("Jordan policy share (%)"), {
    target: { value: "40" },
  });
  fireEvent.change(f.getByLabelText("Shared-production agreement reference"), {
    target: { value: "Approved agreement" },
  });
  expect(
    f.getByRole("button", { name: "Approve policy allocation" }),
  ).toBeDisabled();
  fireEvent.click(f.getByRole("checkbox"));
  fireEvent.click(f.getByRole("button", { name: "Approve policy allocation" }));
  await waitFor(() =>
    expect(h.action).toHaveBeenCalledWith(
      "approvePolicyAllocation",
      expect.objectContaining({
        id: "p",
        version: 1,
        houseBps: 0,
        participants: [
          { producerId: "producer", shareBps: 6000 },
          { producerId: "jordan", shareBps: 4000 },
        ],
        confirmed: true,
      }),
    ),
  );
});
it("creates a departure review without disabling access or automatically excluding receipts", async () => {
  render(
    <CommissionExceptions refreshLedger={vi.fn()} onAccessDenied={vi.fn()} />,
  );
  const f = await open("Create a departure review");
  for (const [label, value] of [
    ["Departing employee", "producer"],
    ["Employment end date", "2026-11-05"],
    ["HR payment due", "2026-11-06"],
    ["Departure agreement reference", "Signed terms"],
    ["Departure supporting evidence", "Owner reviewed"],
  ])
    fireEvent.change(f.getByLabelText(label), { target: { value } });
  fireEvent.click(f.getByRole("button", { name: "Save departure for review" }));
  await waitFor(() =>
    expect(h.action).toHaveBeenCalledWith(
      "saveCommissionDeparture",
      expect.objectContaining({
        producerId: "producer",
        laterReceipts: "REVIEW",
        renewals: "REVIEW",
        accessDisabledOn: "",
        version: 0,
      }),
    ),
  );
});
it("saves a draft adjustment without approving money or manufacturing a carrier receipt", async () => {
  render(
    <CommissionExceptions refreshLedger={vi.fn()} onAccessDenied={vi.fn()} />,
  );
  const f = await open("Create a compensation adjustment");
  for (const [label, value] of [
    ["Adjustment policy", "p"],
    ["Adjustment employee", "producer"],
    ["Additional earnings (USD)", "25.15"],
    ["Compensation adjustment reason", "Approved supplement"],
    ["Compensation adjustment evidence", "Signed addendum"],
  ])
    fireEvent.change(f.getByLabelText(label), { target: { value } });
  fireEvent.click(
    f.getByRole("button", { name: "Save adjustment for review" }),
  );
  await waitFor(() =>
    expect(h.action).toHaveBeenCalledWith(
      "saveCommissionAdjustment",
      expect.objectContaining({
        correctedCents: 2515,
        kind: "ADDITIONAL",
        version: 0,
      }),
    ),
  );
  expect(
    h.action.mock.calls.some(
      ([op]) => op === "postStatement" || op === "approveCommissionAdjustment",
    ),
  ).toBe(false);
});
it("requires a second explicit action to approve a paid recovery review", async () => {
  data.adjustments = [
    {
      id: "a",
      version: 1,
      policyId: "p",
      producerId: "producer",
      adjustmentType: "PAID_RECOVERY",
      originalCents: 16000,
      correctedCents: 10000,
      amountCents: -6000,
      effectiveOn: "2026-11-01",
      reason: "Review recovery",
      evidence: "Agreement",
      status: "DRAFT",
    },
  ];
  render(
    <CommissionExceptions refreshLedger={vi.fn()} onAccessDenied={vi.fn()} />,
  );
  const f = await open("Avery · paid recovery · draft");
  expect(
    f.getByText("Proposed recovery only. No automatic payroll deduction."),
  ).toBeInTheDocument();
  const button = f.getByRole("button", {
    name: "Approve compensation adjustment",
  });
  expect(button).toBeDisabled();
  fireEvent.click(
    f.getByRole("checkbox", { name: /I reviewed the source earnings/ }),
  );
  fireEvent.click(button);
  await waitFor(() =>
    expect(h.action).toHaveBeenCalledWith("approveCommissionAdjustment", {
      id: "a",
      version: 1,
      confirmed: true,
    }),
  );
});
it("clears private case data on authorization failure", async () => {
  const denied = vi.fn();
  render(
    <CommissionExceptions refreshLedger={vi.fn()} onAccessDenied={denied} />,
  );
  await screen.findByText("Create a departure review");
  h.action.mockRejectedValue(
    new Error("Not authorized: Owner access required"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh exceptions" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Not authorized");
  expect(screen.queryByText("Create a departure review")).toBeNull();
  expect(denied).toHaveBeenCalled();
});
