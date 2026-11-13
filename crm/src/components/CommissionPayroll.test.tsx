import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { PayrollWorkspace } from "../../../shared/commissionPayroll";
const h = vi.hoisted(() => ({ action: vi.fn(), team: vi.fn() }));
vi.mock("../lib/commissions", () => ({ commissionAction: h.action }));
vi.mock("../lib/communications", () => ({ communicationRequest: h.team }));
vi.mock("../lib/client", () => ({
  friendlyError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("../lib/editProtection", () => ({ useUnsavedChanges: vi.fn() }));
import CommissionPayroll from "./CommissionPayroll";

let workspace: PayrollWorkspace;
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-05T15:00:00Z"));
  workspace = {
    owner: true,
    environment: "local",
    settings: {
      id: "payroll",
      version: 1,
      enabled: false,
      hrRecipient: "",
      reviewRecipient: "",
      employees: [],
    },
    deliveries: [],
    batches: [],
    cycles: [
      {
        id: "2026-11",
        version: 1,
        revision: 1,
        cutoff: "2026-11-16",
        reviewOn: "2026-11-17",
        hrDueOn: "2026-11-20",
        processingOn: "2026-11-23",
        payDate: "2026-11-27",
        status: "OPEN",
        batchIds: [],
        totalCents: 0,
        employees: [],
        preview: {
          blockers: [],
          token: "reviewed-token",
          totalCents: 16000,
          entryCount: 1,
          employees: [{ producerId: "p", name: "Avery", amountCents: 16000 }],
        },
      },
    ],
  };
  h.action.mockImplementation(async (op: string) =>
    op === "payrollWorkspace" ? structuredClone(workspace) : { ok: true },
  );
  h.team.mockResolvedValue({
    team: [
      { userId: "p", name: "Avery" },
      { userId: "hr", name: "HR" },
    ],
  });
});
afterEach(() => vi.useRealTimers());
it("requires explicit approval and submits the exact preview token", async () => {
  render(<CommissionPayroll owner refreshLedger={vi.fn()} />);
  const button = await screen.findByRole("button", {
    name: "Approve payroll cycle",
  });
  expect(button).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed carrier receipts/ }),
  );
  fireEvent.click(button);
  await waitFor(() =>
    expect(h.action).toHaveBeenCalledWith("approvePayrollCycle", {
      id: "2026-11",
      version: 1,
      previewToken: "reviewed-token",
      confirmed: true,
    }),
  );
});
it("configures an HR inbox without assigning access or requiring acknowledgement", async () => {
  workspace.cycles[0].status = "APPROVED";
  render(<CommissionPayroll owner refreshLedger={vi.fn()} />);
  fireEvent.click(await screen.findByText("Report delivery settings"));
  expect(
    screen.getByRole("textbox", { name: "HR report email" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "HR teammate" })).toBeNull();
  expect(screen.queryByText("Payroll employee mapping")).toBeNull();
  expect(
    screen.getByText(
      /No payroll employee IDs, earnings codes, or import template/,
    ),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Acknowledge payroll receipt" }),
  ).toBeNull();
  expect(
    screen.getByText("Confirm completed payroll payment"),
  ).toBeInTheDocument();
});
it("clears sensitive totals when refresh fails", async () => {
  render(<CommissionPayroll owner refreshLedger={vi.fn()} />);
  expect(
    await screen.findByRole("cell", { name: "Avery" }),
  ).toBeInTheDocument();
  h.action.mockRejectedValue(new Error("Connection lost"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh payroll" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost");
  expect(screen.queryByText("2026-11 · OPEN")).toBeNull();
});
it("clears payroll immediately when an Owner action loses authorization", async () => {
  workspace.cycles[0].status = "APPROVED";
  render(<CommissionPayroll owner refreshLedger={vi.fn()} />);
  const button = await screen.findByRole("button", {
    name: "Download HR summary PDF",
  });
  h.action.mockRejectedValue(
    new Error(
      "Not authorized: only the active Owner can manage commission payroll.",
    ),
  );
  fireEvent.click(button);
  expect(await screen.findByRole("alert")).toHaveTextContent("Not authorized");
  expect(
    screen.queryByRole("button", { name: "Download HR summary PDF" }),
  ).toBeNull();
});
it("keeps automatic delivery off and disabled outside production", async () => {
  render(<CommissionPayroll owner refreshLedger={vi.fn()} />);
  fireEvent.click(await screen.findByText("Report delivery settings"));
  expect(
    screen.getByRole("checkbox", { name: "Enable automatic report delivery" }),
  ).not.toBeChecked();
  expect(
    screen.getByRole("checkbox", { name: "Enable automatic report delivery" }),
  ).toBeDisabled();
});
it("suggests the shared Friday cutoff and Monday report schedule", async () => {
  render(<CommissionPayroll owner refreshLedger={vi.fn()} />);
  const heading = await screen.findByText("Add a payroll month");
  fireEvent.click(heading);
  const form = within(heading.closest("details")!);
  fireEvent.change(form.getByLabelText("Payroll month"), {
    target: { value: "2026-11" },
  });
  fireEvent.change(form.getByLabelText("Receipts included through"), {
    target: { value: "2026-11-15" },
  });
  fireEvent.click(
    form.getByRole("button", {
      name: "Use standard Friday cutoff and Monday report",
    }),
  );
  expect(form.getByLabelText("Last regular pay date of month")).toHaveValue(
    "2026-11-27",
  );
  expect(form.getByLabelText("Payroll processing date")).toHaveValue(
    "2026-11-23",
  );
  expect(form.getByLabelText("HR report due date")).toHaveValue("2026-11-23");
  expect(form.getByLabelText("Receipts included through")).toHaveValue(
    "2026-11-20",
  );
});
it("blocks approval while reconciliation or eligibility issues remain", async () => {
  workspace.cycles[0].preview!.blockers = [
    "Reconcile draft statement NOV received 2026-11-16.",
  ];
  render(<CommissionPayroll owner refreshLedger={vi.fn()} />);
  const button = await screen.findByRole("button", {
    name: "Approve payroll cycle",
  });
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed carrier receipts/ }),
  );
  expect(button).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Reconcile draft statement NOV",
  );
});
it("requires review before approving a zero-commission month", async () => {
  workspace.cycles[0].preview = {
    blockers: [],
    token: "zero-token",
    totalCents: 0,
    entryCount: 0,
    employees: [],
  };
  render(<CommissionPayroll owner refreshLedger={vi.fn()} />);
  const button = await screen.findByRole("button", {
    name: "Approve payroll cycle",
  });
  expect(button).toBeDisabled();
  expect(
    screen.getByText(/Approve a zero report only after checking/),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed carrier receipts/ }),
  );
  expect(button).toBeEnabled();
});
it("disables payroll export when a new issue requires fresh approval", async () => {
  workspace.cycles[0].status = "APPROVED";
  workspace.cycles[0].reviewRequired =
    "A policy review was added after approval.";
  render(<CommissionPayroll owner refreshLedger={vi.fn()} />);
  expect(
    await screen.findByRole("button", { name: "Download HR summary PDF" }),
  ).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "A policy review was added after approval.",
  );
});
it("records the actual partial dollar amount with a stable payment identity", async () => {
  workspace.cycles[0] = {
    ...workspace.cycles[0],
    status: "APPROVED",
    batchIds: ["batch"],
    totalCents: 16000,
  };
  workspace.batches = [
    {
      id: "batch",
      version: 1,
      producerId: "p",
      producerName: "Avery",
      cutoff: "2026-11-16",
      payDate: "2026-11-27",
      status: "APPROVED",
      totalCents: 16000,
      lines: [],
    },
  ];
  render(<CommissionPayroll owner refreshLedger={vi.fn()} />);
  fireEvent.click(
    await screen.findByText("Record individual employee payments"),
  );
  fireEvent.change(screen.getByLabelText("Amount paid to Avery (USD)"), {
    target: { value: "60.00" },
  });
  fireEvent.change(screen.getByLabelText("Payment reference for Avery"), {
    target: { value: "PAY-1" },
  });
  const button = screen.getByRole("button", {
    name: "Record payment for Avery",
  });
  expect(button).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I verified this amount/ }),
  );
  fireEvent.click(button);
  await waitFor(() =>
    expect(h.action).toHaveBeenCalledWith(
      "confirmPayrollEmployee",
      expect.objectContaining({
        amountCents: 6000,
        paymentId: expect.any(String),
        batchId: "batch",
        paymentReference: "PAY-1",
        confirmed: true,
      }),
    ),
  );
});
it("creates an off-cycle draft for selected CRM employees without approving it", async () => {
  workspace.producers = [
    { id: "p", name: "Avery" },
    { id: "other", name: "Jordan" },
  ];
  render(<CommissionPayroll owner refreshLedger={vi.fn()} />);
  const heading = await screen.findByText("Add an off-cycle payment");
  fireEvent.click(heading);
  const form = within(heading.closest("details")!);
  fireEvent.click(form.getByRole("checkbox", { name: "Avery" }));
  fireEvent.change(form.getByLabelText("Off-cycle reason"), {
    target: { value: "Supplemental payroll" },
  });
  fireEvent.click(form.getByRole("button", { name: "Create off-cycle draft" }));
  await waitFor(() =>
    expect(h.action).toHaveBeenCalledWith(
      "savePayrollCycle",
      expect.objectContaining({
        id: expect.stringMatching(/^2026-11-OFF-/),
        producerIds: ["p"],
        reason: "Supplemental payroll",
        version: 0,
      }),
    ),
  );
  expect(h.action.mock.calls.some(([op]) => op === "approvePayrollCycle")).toBe(
    false,
  );
});
it("records the HR hold confirmation and reason for a report revision", async () => {
  workspace.cycles[0].status = "APPROVED";
  render(<CommissionPayroll owner refreshLedger={vi.fn()} />);
  fireEvent.click(await screen.findByText("Correct an unpaid report"));
  fireEvent.change(screen.getByLabelText("Report correction reason"), {
    target: { value: "Corrected receipt allocation" },
  });
  fireEvent.click(
    screen.getByRole("checkbox", { name: /HR has held the original/ }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Reopen as a new revision" }),
  );
  await waitFor(() =>
    expect(h.action).toHaveBeenCalledWith("reopenPayrollCycle", {
      id: "2026-11",
      version: 1,
      reason: "Corrected receipt allocation",
      hrHeld: true,
    }),
  );
});
it("requires an historical-use acknowledgement before downloading prior versions", async () => {
  workspace.reports = [
    {
      id: "2026-11:1",
      cycleId: "2026-11",
      revision: 1,
      totalCents: 16000,
      createdAt: "2026-11-01T12:00:00Z",
      createdBy: "owner",
      contentHash: "digest",
    },
  ];
  render(<CommissionPayroll owner refreshLedger={vi.fn()} />);
  fireEvent.click(await screen.findByText("Approved report versions"));
  const button = screen.getByRole("button", {
    name: "Download 2026-11 revision 1 files",
  });
  expect(button).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: /I am downloading historical records/,
    }),
  );
  expect(button).toBeEnabled();
});
it("shows the balance and removes replacement actions after a partial payment", async () => {
  workspace.cycles[0] = {
    ...workspace.cycles[0],
    status: "APPROVED",
    totalCents: 16000,
    batchIds: ["batch"],
  };
  workspace.batches = [
    {
      id: "batch",
      version: 2,
      producerId: "p",
      producerName: "Avery",
      status: "APPROVED",
      cutoff: "2026-11-16",
      payDate: "2026-11-27",
      totalCents: 16000,
      paidCents: 6000,
      lines: [],
    },
  ];
  render(<CommissionPayroll owner refreshLedger={vi.fn()} />);
  expect(
    (await screen.findByText("Recorded paid")).parentElement,
  ).toHaveTextContent("Recorded paid $60.00Outstanding $100.00");
  expect(screen.queryByText("Correct an unpaid report")).toBeNull();
  expect(screen.queryByText("Cancel this unpaid cycle")).toBeNull();
});

it("selects an adjustment without including other earnings for the same employee", async () => {
  workspace.producers=[{id:"p",name:"Avery"}];
  const row={producerId:"p",producerName:"Avery",policyId:"policy",policyNumber:"POL-1",accountName:"Cedar",entryId:"receipt",receivedOn:"2026-11-02",transaction:"NEW" as const,agencyCents:100000,producerBps:1000,amountCents:10000,earningId:undefined,source:undefined,shareBps:undefined};
  workspace.availableEarnings=[row,{...row,entryId:"adjustment",earningId:"extra",source:"ADJUSTMENT",amountCents:5000}];
  render(<CommissionPayroll owner refreshLedger={vi.fn()} />);
  const heading=await screen.findByText("Add an off-cycle payment");fireEvent.click(heading);
  const form=within(heading.closest("details")!);
  fireEvent.click(form.getByRole("checkbox",{name:"Avery"}));
  fireEvent.change(form.getByLabelText("Earnings to include"),{target:{value:"selected"}});
  expect(form.getByRole("button",{name:"Create off-cycle draft"})).toBeDisabled();
  fireEvent.click(form.getByRole("checkbox",{name:"Include Avery POL-1 2026-11-02 $50.00"}));
  fireEvent.change(form.getByLabelText("Off-cycle reason"),{target:{value:"TEST extra earnings"}});
  fireEvent.click(form.getByRole("button",{name:"Create off-cycle draft"}));
  await waitFor(()=>expect(h.action).toHaveBeenCalledWith("savePayrollCycle",expect.objectContaining({selectedEarningKeys:[JSON.stringify(["earning","extra"])]})));
});
