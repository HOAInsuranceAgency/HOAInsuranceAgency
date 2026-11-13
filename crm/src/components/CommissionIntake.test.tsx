import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("prioritizes received settlements before older statements awaiting review", async () => {
  const paid={...intake,id:"paid",reference:"TEST-PAID",documentReceivedOn:"2026-11-01",needsReview:0};
  h.action.mockImplementation(async(op)=>op==="intakeWorkspace"?{intakes:[intake,paid],settlements:[{id:"settlement",intakeId:"paid",status:"RECORDED"}],templates:[]}:detail);
  renderInbox();
  const queue=await screen.findByRole("region",{name:"Prioritized commission work"});
  expect(within(queue).getAllByRole("button").map(b=>b.textContent)).toEqual(["Review settlement","Review statement"]);
});
it("loads the saved spreadsheet automatically without approving or importing it",async()=>{
  const source={...intake,filename:"sample.csv",rowCount:0};
  const fetcher=vi.fn().mockResolvedValue({ok:true,text:async()=>"Policy,Reference,Amount\nPOL-1,T1,100.00"});
  vi.stubGlobal("fetch",fetcher);
  h.action.mockImplementation(async(op)=>op==="intakeWorkspace"?{intakes:[source],settlements:[],templates:[]}:op==="getStatementIntake"?{...detail,intake:source,rows:[]}:op==="file"?{url:"https://example.test/private-source"}:{draft:null});
  renderInbox();
  fireEvent.click(await screen.findByRole("button",{name:"Open"}));
  await screen.findByLabelText("Table / worksheet");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(h.action.mock.calls.some(([op])=>["saveIntakeRows","postIntakeSettlement"].includes(op))).toBe(false);
});
it("polls extraction automatically and cancels polling when the statement is closed",async()=>{
  const source={...intake,rowCount:0,extractionJobId:"existing-job"};
  h.action.mockImplementation(async(op)=>op==="intakeWorkspace"?{intakes:[source],settlements:[],templates:[]}:op==="getStatementIntake"?{...detail,intake:source,rows:[]}:op==="extractIntakeDocument"?{status:"PROCESSING"}:{draft:null});
  vi.useFakeTimers();
  let view: ReturnType<typeof renderInbox>;
  await act(async()=>{ view=renderInbox(); });
  await act(async()=>{ fireEvent.click(screen.getByRole("button",{name:"Open"})); });
  expect(h.action.mock.calls.filter(([op])=>op==="extractIntakeDocument")).toHaveLength(1);
  await act(async()=>{await vi.advanceTimersByTimeAsync(3100)});
  expect(h.action.mock.calls.filter(([op])=>op==="extractIntakeDocument")).toHaveLength(2);
  view!.unmount();
  const count=h.action.mock.calls.length;
  await act(async()=>{await vi.advanceTimersByTimeAsync(10_000)});
  expect(h.action.mock.calls).toHaveLength(count);
});
it("confirms allocation and posts the verified settlement in one reviewed action",async()=>{
  let settlement={id:"s1",version:1,intakeId:"inbox",reference:"TEST-BANK",receivedOn:"2026-10-03",totalCents:10000,status:"RECORDED",allocations:[] as {rowId:string;amountCents:number}[],postedRows:[],evidence:"TEST bank receipt"};
  const source={...intake,needsReview:0};
  h.action.mockImplementation(async(op,input)=>{
    if(op==="intakeWorkspace")return{intakes:[source],settlements:[settlement],templates:[]};
    if(op==="getStatementIntake")return{intake:source,rows:[{...row,reviewStatus:"ELIGIBLE"}],settlements:[settlement]};
    if(op==="previewIntakeSettlement")return{calculations:[],employeeCents:1000};
    if(op==="allocateIntakeSettlement"){settlement={...settlement,status:"POSTING",version:2,allocations:input.allocations};return{ok:true}}
    if(op==="postIntakeSettlement")return{complete:true,postedRows:1,totalRows:1};
    return{draft:null};
  });
  renderInbox();
  fireEvent.click(await screen.findByRole("button",{name:"Open"}));
  fireEvent.click(await screen.findByRole("button",{name:"Fill remaining reviewed amounts"}));
  const button=screen.getByRole("button",{name:"Confirm allocation & post earnings"});
  expect(button).toBeDisabled();
  fireEvent.click(screen.getByLabelText(/I reviewed the source matches/));
  fireEvent.click(button);
  await waitFor(()=>expect(h.action).toHaveBeenCalledWith("postIntakeSettlement",expect.objectContaining({settlementId:"s1",version:2,confirmed:true})));
  const operations=h.action.mock.calls.map(([op])=>op);
  expect(operations.indexOf("allocateIntakeSettlement")).toBeLessThan(operations.indexOf("postIntakeSettlement"));
});

it("retains a resumable allocation when posting is interrupted instead of allocating twice",async()=>{
  let settlement={id:"s1",version:1,intakeId:"inbox",reference:"TEST-BANK",receivedOn:"2026-10-03",totalCents:10000,status:"RECORDED",allocations:[] as {rowId:string;amountCents:number}[],postedRows:[],evidence:"TEST bank receipt"};
  let interrupted=true;
  const source={...intake,needsReview:0};
  h.action.mockImplementation(async(op,input)=>{
    if(op==="intakeWorkspace")return{intakes:[source],settlements:[settlement],templates:[]};
    if(op==="getStatementIntake")return{intake:source,rows:[{...row,reviewStatus:"ELIGIBLE"}],settlements:[settlement]};
    if(op==="previewIntakeSettlement")return{calculations:[],employeeCents:1000};
    if(op==="allocateIntakeSettlement"){settlement={...settlement,status:"POSTING",version:2,allocations:input.allocations};return{ok:true}}
    if(op==="postIntakeSettlement"){if(interrupted){interrupted=false;throw new Error("Connection lost")}return{complete:true,postedRows:1,totalRows:1}}
    return{draft:null};
  });
  renderInbox();
  fireEvent.click(await screen.findByRole("button",{name:"Open"}));
  fireEvent.click(await screen.findByRole("button",{name:"Fill remaining reviewed amounts"}));
  fireEvent.click(screen.getByLabelText(/I reviewed the source matches/));
  fireEvent.click(screen.getByRole("button",{name:"Confirm allocation & post earnings"}));
  await screen.findByText(/Allocation saved. Posting stopped/);
  fireEvent.click(screen.getByRole("button",{name:"Refresh statement"}));
  fireEvent.click(await screen.findByRole("button",{name:"Post verified settlement"}));
  await waitFor(()=>expect(h.action.mock.calls.filter(([op])=>op==="postIntakeSettlement")).toHaveLength(2));
  expect(h.action.mock.calls.filter(([op])=>op==="allocateIntakeSettlement")).toHaveLength(1);
});
