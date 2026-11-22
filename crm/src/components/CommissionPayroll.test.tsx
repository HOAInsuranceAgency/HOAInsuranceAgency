import { CommissionWorkflowContext } from '../lib/commissionWorkflow';
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
vi.mock("../lib/editProtection", () => ({ useUnsavedChanges: vi.fn(), useEditProtection: () => ({ requestLeave: (fn: () => void) => fn() }) }));
import CommissionPayroll from "./CommissionPayroll";

let workspace: PayrollWorkspace;
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-21T15:00:00Z"));
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
it("opens the IPFS fee reconciliation from a paid employee calculation", async () => {
  workspace.cycles[0] = { ...workspace.cycles[0], status: 'PAID', batchIds: ['batch'], totalCents: 16000 };
  const item = { policyId: 'policy', entryId: 'fee', accountName: 'Cedar HOA', policyNumber: 'POL-1',
    receivedOn: '2026-11-10', transaction: 'NEW' as const, agencyCents: 100000, producerBps: 1600, amountCents: 16000, revenueKind: 'IPFS_FEE' as const };
  workspace.batches = [{ id: 'batch', version: 1, producerId: 'p', producerName: 'Avery', status: 'PAID',
    payDate: '2026-11-27', cutoff: '2026-11-16', totalCents: 16000, lines: [item] }];
  const navigate = vi.fn();
  render(<CommissionWorkflowContext.Provider value={{target:{tab:'payroll'},navigate}}><CommissionPayroll owner refreshLedger={vi.fn()}/></CommissionWorkflowContext.Provider>);
  fireEvent.click(await screen.findByText('Employee calculations & source statements'));
  fireEvent.click(screen.getByText('Avery · $160.00', {selector:'summary'}));
  const row = screen.getByText(/16% saved rate · IPFS financing fee/).parentElement!.parentElement!;
  expect(within(row).getByText('POL-1 · $160.00')).toBeVisible();
  fireEvent.click(within(row).getByRole('button', {name:'Open source'}));
  expect(navigate).toHaveBeenCalledWith({tab:'ipfs',policyId:'policy'});
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

it("focuses on one payroll cycle while preserving access to older cycles", async () => {
  workspace.cycles.push({...workspace.cycles[0],id:"2026-10",status:"PAID"});
  render(<CommissionPayroll owner refreshLedger={vi.fn()} />);
  const picker=await screen.findByRole("combobox",{name:/Review payroll cycle/});
  expect(screen.getAllByRole("table",{name:/Employee totals/})).toHaveLength(1);
  expect(screen.getByRole("table",{name:"Employee totals for 2026-11"})).toBeInTheDocument();
  fireEvent.change(picker,{target:{value:"2026-10"}});
  expect(screen.getByRole("table",{name:"Employee totals for 2026-10"})).toBeInTheDocument();
  expect(screen.queryByRole("button",{name:"Approve payroll cycle"})).toBeNull();
});

it("keeps readiness dates and employee totals on the same selected cycle", async () => {
  workspace.statementReadiness={activeStatements:0,statementsNeedingReview:0,unmatchedRows:0,pendingSettlements:[]};
  workspace.cycles.push({...workspace.cycles[0],id:"2026-10",cutoff:"2026-10-23",hrDueOn:"2026-10-26",payDate:"2026-10-30"});
  render(<CommissionPayroll owner refreshLedger={vi.fn()} />);
  const picker=await screen.findByRole("combobox",{name:/Review payroll cycle/});
  expect(screen.getByRole("table",{name:"Employee totals for 2026-10"})).toBeInTheDocument();
  expect(screen.getByRole("region",{name:"Payroll readiness"})).toHaveTextContent("Oct 23, 2026");
  fireEvent.change(picker,{target:{value:"2026-11"}});
  expect(screen.getByRole("table",{name:"Employee totals for 2026-11"})).toBeInTheDocument();
  expect(screen.getByRole("region",{name:"Payroll readiness"})).toHaveTextContent("Nov 16, 2026");
});

it("uses the same inclusive cutoff block in readiness and the approval action",async()=>{
  vi.setSystemTime(new Date('2026-11-16T22:00:00Z'));
  workspace.statementReadiness={activeStatements:0,statementsNeedingReview:0,unmatchedRows:0,pendingSettlements:[]};
  render(<CommissionPayroll owner refreshLedger={vi.fn()}/>);
  await screen.findByRole('button',{name:'Approve payroll cycle'});
  fireEvent.click(screen.getByRole('checkbox',{name:/I reviewed carrier receipts/}));
  expect(screen.getByRole('button',{name:'Approve payroll cycle'})).toBeDisabled();
  expect(screen.getByRole('region',{name:'Payroll readiness'})).toHaveTextContent('inclusive receipt cutoff');
  expect(h.action.mock.calls.some(([op])=>op==='approvePayrollCycle')).toBe(false);
});
it("opens cancellation as a separate confirmed dialog without cancelling on open",async()=>{
  render(<CommissionPayroll owner refreshLedger={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Cancel cycle…'}));
  const modal=within(screen.getByRole('dialog'));
  expect(modal.getByRole('button',{name:'Cancel payroll cycle'})).toBeDisabled();
  expect(h.action.mock.calls.some(([op])=>op==='cancelPayrollCycle')).toBe(false);
  fireEvent.change(modal.getByLabelText('Cancellation reason'),{target:{value:'TEST duplicate draft'}});
  fireEvent.click(modal.getByRole('checkbox',{name:/I confirm this cycle/}));
  fireEvent.click(modal.getByRole('button',{name:'Cancel payroll cycle'}));
  await waitFor(()=>expect(h.action).toHaveBeenCalledWith('cancelPayrollCycle',{id:'2026-11',version:1,reason:'TEST duplicate draft'}));
});
it("carries a contextual earning into an off-cycle draft without including another earning",async()=>{
  workspace.producers=[{id:'p',name:'Avery'}];
  const row={producerId:'p',producerName:'Avery',policyId:'policy',policyNumber:'POL-1',accountName:'Cedar',entryId:'receipt',receivedOn:'2026-11-02',transaction:'NEW' as const,agencyCents:100000,producerBps:1000,amountCents:10000,earningId:undefined,source:undefined,shareBps:undefined};
  workspace.availableEarnings=[row,{...row,entryId:'other',amountCents:5000}];
  const key=JSON.stringify(['receipt','policy','receipt']);
  render(<CommissionWorkflowContext.Provider value={{target:{tab:'payroll',earningKeys:[key],producerId:'p'},navigate:vi.fn()}}><CommissionPayroll owner refreshLedger={vi.fn()}/></CommissionWorkflowContext.Provider>);
  const title=await screen.findByText('Add an off-cycle payment');
  const form=within(title.closest('details')!);
  expect(form.getByRole('checkbox',{name:'Include Avery POL-1 2026-11-02 $100.00'})).toBeChecked();
  expect(form.getByRole('checkbox',{name:'Include Avery POL-1 2026-11-02 $50.00'})).not.toBeChecked();
  fireEvent.change(form.getByLabelText('Off-cycle reason'),{target:{value:'TEST selected earning'}});
  fireEvent.click(form.getByRole('button',{name:'Create off-cycle draft'}));
  await waitFor(()=>expect(h.action).toHaveBeenCalledWith('savePayrollCycle',expect.objectContaining({selectedEarningKeys:[key],producerIds:['p']})));
});
it("opens the exact review destination supplied by payroll validation",async()=>{
  workspace.cycles[0].preview!.blockers=['Finish received settlement TEST'];
  workspace.cycles[0].preview!.issues=[{message:'Finish received settlement TEST',target:{tab:'statements',intakeId:'source-123'}}];
  const navigate=vi.fn();
  render(<CommissionWorkflowContext.Provider value={{target:{tab:'payroll'},navigate}}><CommissionPayroll owner refreshLedger={vi.fn()}/></CommissionWorkflowContext.Provider>);
  fireEvent.click(await screen.findByRole('button',{name:'Open statement to resolve'}));
  expect(navigate).toHaveBeenCalledWith({tab:'statements',intakeId:'source-123'});
});

it("keeps statement payroll separate from an older employee-wide run and prepares only its exact earnings after a click",async()=>{
  workspace.producers=[{id:"p",name:"Avery"}];
  const earnings=[{producerId:"p",producerName:"Avery",policyId:"policy",entryId:"receipt-1",accountName:"Test HOA",policyNumber:"TEST-MAIN",receivedOn:"2026-11-11",transaction:"NEW_BUSINESS",agencyCents:100000,producerBps:1000,amountCents:10000},{producerId:"p",producerName:"Avery",policyId:"policy",entryId:"receipt-2",accountName:"Test HOA",policyNumber:"TEST-MAIN",receivedOn:"2026-11-11",transaction:"NEW_BUSINESS",agencyCents:50000,producerBps:1000,amountCents:5000}];
  workspace.availableEarnings=[...earnings,{...earnings[0],entryId:"other",amountCents:34541}] as PayrollWorkspace['availableEarnings'];
  workspace.sourceLinks=earnings.map(e=>({intakeId:"source",statementId:"s",policyId:e.policyId,entryId:e.entryId}));
  workspace.cycles.unshift({...workspace.cycles[0],id:"2026-11-OFF-old",cycleType:"OFF_CYCLE",cutoff:"2026-11-12",producerIds:["p"]});
  const navigate=vi.fn();
  render(<CommissionWorkflowContext.Provider value={{target:{tab:"payroll",intakeId:"source",intakeReference:"TEST-MAIN"},navigate}}><CommissionPayroll owner refreshLedger={vi.fn()}/></CommissionWorkflowContext.Provider>);
  expect(await screen.findByText("2 available earnings · $150.00")).toBeVisible();
  expect(screen.queryByRole("combobox",{name:"Review payroll cycle"})).toBeNull();
  expect(screen.queryByRole("button",{name:"Approve payroll cycle"})).toBeNull();
  expect(h.action.mock.calls.every(([op])=>op==="payrollWorkspace")).toBe(true);
  fireEvent.click(screen.getByRole("button",{name:"Prepare payroll for these earnings"}));
  expect(screen.getByLabelText("Off-cycle reason")).toHaveValue("Statement TEST-MAIN");
  expect(screen.getByLabelText("Off-cycle receipt cutoff")).toHaveValue("2026-11-16");
  expect(screen.getAllByRole("checkbox",{name:/Include Avery/})).toHaveLength(2);
  fireEvent.click(screen.getByRole("button",{name:"Change employees or earnings"}));
  const rows=screen.getAllByRole("checkbox",{name:/Include Avery/});expect(rows).toHaveLength(3);expect(rows[0]).toBeChecked();expect(rows[1]).toBeChecked();expect(rows[2]).not.toBeChecked();
  fireEvent.click(screen.getByRole("button",{name:"Create payroll draft"}));
  await waitFor(()=>expect(h.action).toHaveBeenCalledWith("savePayrollCycle",expect.objectContaining({producerIds:["p"],reason:"Statement TEST-MAIN",selectedEarningKeys:earnings.map(e=>JSON.stringify(["receipt",e.policyId,e.entryId]))})));
  expect(navigate).toHaveBeenCalledWith(expect.objectContaining({tab:"payroll",intakeId:"source",intakeReference:"TEST-MAIN",cycleId:expect.stringMatching(/^2026-11-OFF-/)}));
  expect(h.action.mock.calls.some(([op])=>op==="approvePayrollCycle")).toBe(false);
});

it("retains the selected payroll cycle when reviewing an earlier source step",async()=>{
 const navigate=vi.fn();render(<CommissionWorkflowContext.Provider value={{target:{tab:"payroll",intakeId:"source",intakeReference:"TEST-MAIN",cycleId:"2026-11"},navigate}}><CommissionPayroll owner refreshLedger={vi.fn()}/></CommissionWorkflowContext.Provider>);
 fireEvent.click(await screen.findByRole("button",{name:"Step 3: Carrier payment, complete"}));
 expect(navigate).toHaveBeenCalledWith({tab:"statements",intakeId:"source",intakeReference:"TEST-MAIN",cycleId:"2026-11",intakeStep:2});
});

it("explains a date hold and opens the editor without saving or approving", async () => {
  vi.setSystemTime(new Date("2026-11-16T22:00:00Z"));
  workspace.statementReadiness={activeStatements:0,statementsNeedingReview:0,unmatchedRows:0,pendingSettlements:[]};
  render(<CommissionPayroll owner refreshLedger={vi.fn()} reviewStatements={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button",{name:"Review payroll dates"}));
  expect(screen.getByRole("region",{name:"Payroll readiness"})).toHaveTextContent("Waiting for cutoff");
  expect(screen.getByRole("region",{name:"Payroll readiness"})).toHaveTextContent("No reconciliation issues");
  expect(within(screen.getByRole("region",{name:"November 2026 monthly payroll"})).getByRole("status",{name:"Payroll schedule"})).toHaveTextContent("Approval opens Nov 17, 2026");
  expect(screen.queryByRole("button",{name:"Review statements awaiting posting"})).toBeNull();
  const cutoff=within(screen.getByRole("region",{name:"November 2026 monthly payroll"})).getByLabelText("Receipts included through");
  expect(cutoff.closest("details")).toHaveAttribute("open");
  expect(cutoff).toHaveFocus();
  expect(h.action.mock.calls.every(([op])=>op==="payrollWorkspace")).toBe(true);
});
it("prioritizes a real reconciliation issue over a scheduled wait", async () => {
  vi.setSystemTime(new Date("2026-11-16T22:00:00Z"));
  workspace.statementReadiness={activeStatements:1,statementsNeedingReview:0,unmatchedRows:0,pendingSettlements:[]};
  workspace.cycles[0].preview!.blockers=["Reconcile draft statement TEST received 2026-11-11."];
  workspace.cycles[0].preview!.issues=[{message:workspace.cycles[0].preview!.blockers[0],target:{tab:"statements",intakeId:"source-123"}}];
  const navigate=vi.fn();
  render(<CommissionWorkflowContext.Provider value={{target:{tab:"payroll"},navigate}}><CommissionPayroll owner refreshLedger={vi.fn()}/></CommissionWorkflowContext.Provider>);
  fireEvent.click(await screen.findByRole("button",{name:"Resolve next review item"}));
  expect(navigate).toHaveBeenCalledWith({tab:"statements",intakeId:"source-123"});
  expect(screen.getByRole("region",{name:"Payroll readiness"})).toHaveTextContent("1 review item to resolve");
  expect(screen.getByRole("button",{name:"Approve payroll cycle"})).toBeDisabled();
});
it("suggests a receipt cutoff only on request and preserves exact earnings and remaining dates", async () => {
  vi.setSystemTime(new Date("2026-11-17T15:00:00Z"));
  const row={producerId:"p",producerName:"Avery",policyId:"policy",policyNumber:"TEST-MAIN",accountName:"Test HOA",entryId:"receipt",receivedOn:"2026-11-11",transaction:"NEW" as const,agencyCents:100000,producerBps:1000,amountCents:10000,earningId:undefined,source:undefined,shareBps:undefined};
  const key=JSON.stringify(["receipt","policy","receipt"]);
  workspace.producers=[{id:"p",name:"Avery"}];
  workspace.availableEarnings=[row,{...row,entryId:"unrelated",amountCents:5000}];
  workspace.cycles[0]={...workspace.cycles[0],id:"2026-11-OFF-12345678",cycleType:"OFF_CYCLE",cutoff:"2026-11-20",reviewOn:"2026-11-21",hrDueOn:"2026-11-23",processingOn:"2026-11-23",reason:"Statement TEST",producerIds:["p"],selectedEarningKeys:[key]};
  render(<CommissionPayroll owner refreshLedger={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button",{name:"Review payroll dates"}));
  const form=within(screen.getByText("Edit off-cycle dates and earnings").closest("details")!);
  expect(form.getByRole("status",{name:"Payroll schedule"})).toHaveTextContent("Approval opens Nov 21, 2026");
  expect(form.getAllByRole("checkbox",{name:/Include Avery/})).toHaveLength(1);
  expect(form.getByLabelText("Off-cycle receipt cutoff")).toHaveValue("2026-11-20");
  fireEvent.click(form.getByRole("button",{name:"Use selected receipts through Nov 11, 2026"}));
  expect(form.getByLabelText("Off-cycle receipt cutoff")).toHaveValue("2026-11-11");
  expect(form.getByLabelText("Off-cycle pay date")).toHaveValue("2026-11-27");
  expect(form.queryByRole("status",{name:"Payroll schedule"})).toBeNull();
  expect(h.action.mock.calls.every(([op])=>op==="payrollWorkspace")).toBe(true);
  fireEvent.click(form.getByRole("button",{name:"Save off-cycle draft"}));
  await waitFor(()=>expect(h.action).toHaveBeenCalledWith("savePayrollCycle",expect.objectContaining({id:"2026-11-OFF-12345678",cutoff:"2026-11-11",reviewOn:"2026-11-21",payDate:"2026-11-27",selectedEarningKeys:[key]})));
  expect(h.action.mock.calls.some(([op])=>op==="approvePayrollCycle")).toBe(false);
});
it("opens stale off-cycle selection in its editor instead of navigating in a loop", async () => {
  const message="Selected off-cycle earnings changed or are no longer eligible. Review the selection before approval.";
  workspace.cycles[0]={...workspace.cycles[0],id:"2026-11-OFF-12345678",cycleType:"OFF_CYCLE",producerIds:["p"],reason:"TEST",preview:{...workspace.cycles[0].preview!,blockers:[message],issues:[{message,target:{tab:"payroll",cycleId:"2026-11-OFF-12345678"}}]}};
  const navigate=vi.fn();
  render(<CommissionWorkflowContext.Provider value={{target:{tab:"payroll"},navigate}}><CommissionPayroll owner refreshLedger={vi.fn()}/></CommissionWorkflowContext.Provider>);
  fireEvent.click(await screen.findByRole("button",{name:"Resolve next review item"}));
  expect(screen.getByText("Edit off-cycle dates and earnings").closest("details")).toHaveAttribute("open");
  expect(navigate).not.toHaveBeenCalled();
  expect(h.action.mock.calls.every(([op])=>op==="payrollWorkspace")).toBe(true);
});
