import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { CommissionOverview } from "../../../shared/commissions";
import { commissionPolicy } from "../test/commissionFixtures";
const h = vi.hoisted(() => ({
  action: vi.fn(),
  attach: vi.fn(),
  markClean: vi.fn(),
}));
vi.mock("../lib/commissions", () => ({ commissionAction: h.action }));
vi.mock("../lib/commissionStatementAttachment", () => ({
  attachCommissionStatement: h.attach,
}));
vi.mock("../lib/editProtection", () => ({
  useUnsavedChanges: () => ({ markClean: h.markClean }),
  useEditProtection: () => ({ requestLeave: (fn: () => void) => fn() }),
}));
import CommissionIntake from "./CommissionIntake";
const intake = {
  id: "inbox",
  version: 1,
  carrierId: "c",
  carrierName: "Carrier",
  reference: "TEST-SOURCE",
  source: "source",
  filename: "test.pdf",
  fileHash: "hash",
  documentReceivedOn: "2026-10-02",
  totalCents: 10000,
  status: "OPEN",
  rowCount: 1,
  rowTotalCents: 10000,
  needsReview: 1,
  unmatched: 0,
  postedCents: 0,
  completedRows: 0,
};
const row = {
  id: "r1",
  version: 1,
  intakeId: "inbox",
  policyNumber: "POL-1",
  effectiveDate: "2026-01-01",
  policyId: "p",
  lineRef: "T1",
  agencyCents: 10000,
  transactionType: "RECEIPT",
  reviewStatus: "PENDING",
  note: "",
  postedCents: 0,
};
const detail = { intake, rows: [row], settlements: [] };
const data = {
  plans: [],
  policies: [commissionPolicy()],
  carriers: [commissionPolicy().carrierTerms],
  batches: [],
  statements: [],
} as CommissionOverview;
const renderInbox = () =>
  render(
    <CommissionIntake
      data={data}
      refreshLedger={vi.fn().mockResolvedValue(undefined)}
      renderPolicySetup={() => null}
      onAccessDenied={vi.fn()}
    />,
  );
beforeEach(() => {
  vi.resetAllMocks();
  h.action.mockImplementation(async (op) =>
    op === "intakeWorkspace"
      ? { intakes: [intake], settlements: [], templates: [] }
      : op === "getStatementIntake"
        ? detail
        : { ok: true },
  );
  h.attach.mockResolvedValue({ key: "statements/uploaded" });
});
it("logs an arrival without requesting policy matches or bank payment details", async () => {
  renderInbox();
  fireEvent.click(
    await screen.findByRole("button", { name: "Log carrier statement" }),
  );
  fireEvent.change(screen.getByLabelText("Carrier"), {
    target: { value: "c" },
  });
  fireEvent.change(screen.getByLabelText("Statement reference"), {
    target: { value: "TEST-ARRIVAL" },
  });
  fireEvent.change(screen.getByLabelText("Original file"), {
    target: {
      files: [new File(["test"], "carrier.pdf", { type: "application/pdf" })],
    },
  });
  expect(screen.queryByLabelText("Actual commission receipt date")).toBeNull();
  fireEvent.submit(
    screen.getByRole("button", { name: "Save to inbox" }).closest("form")!,
  );
  await waitFor(() =>
    expect(h.action).toHaveBeenCalledWith(
      "saveStatementIntake",
      expect.objectContaining({
        reference: "TEST-ARRIVAL",
        source: "statements/uploaded",
        carrierId: "c",
      }),
    ),
  );
  expect(
    h.action.mock.calls.some(
      ([op]) =>
        op === "recordIntakeSettlement" || op === "postIntakeSettlement",
    ),
  ).toBe(false);
});
it("requires review confirmation to save routine rows as eligible", async () => {
  renderInbox();
  fireEvent.click(await screen.findByRole("button", { name: "Open" }));
  await screen.findByText("Policy matches & eligibility");
  fireEvent.click(screen.getByLabelText("Select source row r1"));
  fireEvent.click(
    screen.getByRole("button", { name: "Mark selected routine rows eligible" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save source rows" }));
  await screen.findByText(
    "Confirm the changed source values and eligibility decisions before saving reviewed rows.",
  );
  expect(h.action.mock.calls.some(([op]) => op === "saveIntakeRows")).toBe(
    false,
  );
  // The UI stops unconfirmed review; explicit confirmation is then carried to the server.
  fireEvent.click(screen.getByLabelText(/I checked changed source values/));
  fireEvent.click(screen.getByRole("button", { name: "Save source rows" }));
  await waitFor(() =>
    expect(h.action).toHaveBeenCalledWith(
      "saveIntakeRows",
      expect.objectContaining({ confirmed: true, extractionReviewed: true }),
    ),
  );
});
it("does not reset an unsaved amount while opening inline policy setup", async () => {
  renderInbox();
  fireEvent.click(await screen.findByRole("button", { name: "Open" }));
  await screen.findByText("Policy matches & eligibility");
  fireEvent.change(screen.getByLabelText("Agency amount r1"), {
    target: { value: "123.45" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Find in CRM / add tracking" }),
  );
  expect(screen.getByLabelText("Agency amount r1")).toHaveValue("123.45");
});
