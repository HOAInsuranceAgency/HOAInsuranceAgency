import { CommissionWorkflowContext } from "../lib/commissionWorkflow";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CommissionOverview } from "../../../shared/commissions";
import { commissionPolicy } from "../test/commissionFixtures";
const h = vi.hoisted(() => ({
  action: vi.fn(),
  attach: vi.fn(),
  markClean: vi.fn(),
  dirty: vi.fn(),
}));
vi.mock("../lib/commissions", () => ({ commissionWorkflowAction: h.action }));
vi.mock("../lib/commissionStatementAttachment", () => ({
  attachCommissionStatement: h.attach,
}));
vi.mock("../lib/editProtection", () => ({
  useUnsavedChanges: (dirty: boolean) => { h.dirty(dirty); return { markClean: h.markClean }; },
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
  fireEvent.click(screen.getByText("Group review tools"));
  fireEvent.click(screen.getByLabelText("Select source row r1"));
  expect(screen.getByLabelText("Select source row r1")).toBeChecked();
  expect(screen.getByRole("button", {name:"Mark selected routine rows eligible"})).toBeEnabled();
  fireEvent.click(
    screen.getByRole("button", { name: "Mark selected routine rows eligible" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save review & continue" }));
  await screen.findByText(
    "Confirm the changed source values and eligibility decisions before saving reviewed rows.",
  );
  expect(h.action.mock.calls.some(([op]) => op === "saveIntakeRows")).toBe(
    false,
  );
  // The UI stops unconfirmed review; explicit confirmation is then carried to the server.
  fireEvent.click(screen.getByLabelText(/I checked changed source values/));
  fireEvent.click(screen.getByRole("button", { name: "Save review & continue" }));
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
  fireEvent.click(screen.getByRole("button", {name:"Edit details T1"}));
  fireEvent.change(screen.getByLabelText("Agency amount r1"), {
    target: { value: "123.45" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Find in CRM / add tracking" }),
  );
  expect(screen.getByLabelText("Agency amount r1")).toHaveValue("$123.45");
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
    if(op==="previewIntakeSettlement")return{token:"reviewed-token",calculations:[],employeeCents:1000};
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
    if(op==="previewIntakeSettlement")return{token:"reviewed-token",calculations:[],employeeCents:1000};
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
  const resume=await screen.findByRole('button',{name:'Confirm remaining calculations & resume posting'});
  expect(resume).toBeDisabled();
  await screen.findByText(/Employee earnings to post/);
  fireEvent.click(screen.getByLabelText(/I reviewed the source matches/));
  fireEvent.click(resume);
  await waitFor(()=>expect(h.action.mock.calls.filter(([op])=>op==="postIntakeSettlement")).toHaveLength(2));
  expect(h.action.mock.calls.filter(([op])=>op==="allocateIntakeSettlement")).toHaveLength(2);
  expect(h.action).toHaveBeenLastCalledWith(expect.any(String),expect.anything());
  expect(h.action.mock.calls.filter(([op])=>op==='allocateIntakeSettlement').every(([,input])=>input.previewToken==='reviewed-token')).toBe(true);
});


it("suggests all recognizable source columns but imports only after confirmation, then focuses review", async () => {
  let current = {...detail, intake:{...intake,filename:"main.csv",rowCount:0,rowTotalCents:0,totalCents:150000,needsReview:0},rows:[] as typeof row[]};
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:true,text:async()=>"Policy,Reference,Amount,Effective,Transaction\nPOL-1,T1,1000.00,2026-01-01,RECEIPT\nPOL-1,T2,500.00,2026-01-01,RECEIPT"}));
  h.action.mockImplementation(async(op,input)=>{
    if(op==="intakeWorkspace") return {intakes:[current.intake],settlements:[],templates:[]};
    if(op==="getStatementIntake") return current;
    if(op==="file") return {url:"https://example.test/private-source"};
    if(op==="saveIntakeRows") { current={...current,intake:{...current.intake,version:2,rowCount:2,rowTotalCents:150000,needsReview:2},rows:input.rows}; return {ok:true}; }
    return {draft:null};
  });
  renderInbox();
  fireEvent.click(await screen.findByRole("button",{name:"Open"}));
  await screen.findByRole("heading",{name:"Next: check columns, then import"});
  await screen.findByLabelText("Policy effective date");
  expect(screen.getByLabelText("Policy number")).toHaveValue("0");
  expect(screen.getByLabelText("Transaction reference")).toHaveValue("1");
  expect(screen.getByLabelText("Agency commission amount")).toHaveValue("2");
  expect(screen.getByLabelText("Policy effective date")).toHaveValue("3");
  expect(screen.getByLabelText("Transaction type")).toHaveValue("4");
  expect(screen.queryByText(/difference to resolve/)).toBeNull();
  const button=screen.getByRole("button",{name:"Import rows & remember format"});
  expect(button).toBeDisabled();
  expect(h.action.mock.calls.some(([op])=>op==="saveIntakeRows")).toBe(false);
  const confirmation=screen.getByRole("checkbox",{name:/I checked the mapping/});
  fireEvent.click(confirmation);
  expect(button).toBeEnabled();
  fireEvent.change(screen.getByLabelText("Policy effective date"),{target:{value:"-1"}});
  expect(confirmation).not.toBeChecked();
  expect(button).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Policy effective date"),{target:{value:"3"}});
  fireEvent.click(confirmation);
  fireEvent.click(button);
  await waitFor(()=>expect(h.action).toHaveBeenCalledWith("saveIntakeRows",expect.objectContaining({confirmed:false,extractionReviewed:false,rows:expect.arrayContaining([expect.objectContaining({agencyCents:100000,reviewStatus:"PENDING"}),expect.objectContaining({agencyCents:50000,reviewStatus:"PENDING"})])})));
  await waitFor(()=>expect(screen.getByRole("heading",{name:"Policy matches & eligibility"})).toHaveFocus());
  expect(h.action.mock.calls.some(([op])=>["recordIntakeSettlement","postIntakeSettlement"].includes(op))).toBe(false);
});

it("formats the total and saved draft as currency without changing signed cents or invalid input", async()=>{
  const source={...intake,totalCents:150000,rowCount:0,rowTotalCents:0};
  h.action.mockImplementation(async(op,input)=>op==="intakeWorkspace"?{intakes:[source],settlements:[],templates:[]}:op==="getStatementIntake"?{...detail,intake:source,rows:[]}:op==="getIntakeWorkingDraft" && input.scope==="header"?{draft:{version:1,baseVersion:0,savedAt:"2026-11-16T14:59:00Z",data:{total:"1500",date:""}}}:{draft:null});
  renderInbox();fireEvent.click(await screen.findByRole("button",{name:"Open"}));
  fireEvent.click(await screen.findByText("Statement details & control total"));
  const input=await screen.findByLabelText("Statement agency commission total ($)");
  expect(input).toHaveValue("$1,500.00");
  const draft=await screen.findByLabelText("Statement details working draft");
  await waitFor(()=>expect(within(draft).getByText("$1,500.00")).toBeInTheDocument());
  fireEvent.focus(input);expect(input).toHaveValue("1500.00");
  fireEvent.change(input,{target:{value:"-25.25"}});fireEvent.blur(input);
  expect(input).toHaveValue("($25.25)");
  fireEvent.submit(input.closest("form")!);
  await waitFor(()=>expect(h.action).toHaveBeenCalledWith("saveStatementIntake",expect.objectContaining({totalCents:-2525})));
  fireEvent.focus(input);fireEvent.change(input,{target:{value:"12.345"}});fireEvent.blur(input);
  expect(input).toHaveValue("12.345");
});


it("keeps reviewed decisions visible until saved, then advances to payment without recording one", async () => {
  let current = structuredClone(detail);
  h.action.mockImplementation(async (op,input) => {
    if (op === "intakeWorkspace") return {intakes:[current.intake],settlements:[],templates:[]};
    if (op === "getStatementIntake") return current;
    if (op === "saveIntakeRows") {
      current={...current,intake:{...current.intake,version:2,needsReview:0},rows:input.rows.map((r:typeof row) => ({...r,version:2}))};
      return {ok:true};
    }
    return {draft:null};
  });
  renderInbox(); fireEvent.click(await screen.findByRole("button",{name:"Open"}));
  const choice=await screen.findByLabelText("Review decision r1");
  fireEvent.change(choice,{target:{value:"ELIGIBLE"}});
  expect(choice).toBeVisible();
  expect(screen.getByRole("table",{name:"Source row review"})).toHaveTextContent("$100.00");
  expect(screen.queryByRole("button",{name:"Save payment & continue"})).toBeNull();
  fireEvent.click(screen.getByLabelText(/I checked changed source values/));
  fireEvent.click(screen.getByRole("button",{name:"Save review & continue"}));
  await waitFor(()=>expect(screen.getByRole("heading",{name:"Confirm carrier payment"})).toHaveFocus());
  expect(screen.getByText("Source review complete")).toBeVisible();
  expect(screen.queryByRole("table",{name:"Source row review"})).toBeNull();
  expect(screen.queryByRole("button",{name:"Import rows & remember format"})).toBeNull();
  expect(screen.getByRole("button",{name:"Save payment & continue"})).toBeDisabled();
  expect(h.action.mock.calls.some(([op])=>["recordIntakeSettlement","postIntakeSettlement"].includes(op))).toBe(false);
  fireEvent.click(screen.getByRole("button",{name:"Step 2: Match & review, complete"}));
  expect(screen.getByText("All row decisions are saved.")).toBeVisible();
  expect(screen.queryByRole("button",{name:"Save source rows"})).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"View reviewed rows"}));
  expect(screen.getByRole("table",{name:"Source row review"})).toHaveTextContent("$100.00");
});

it("keeps a failed review save on the current step with the decisions still available", async () => {
  h.action.mockImplementation(async op => op==="intakeWorkspace"?{intakes:[intake],settlements:[],templates:[]}:op==="getStatementIntake"?detail:op==="saveIntakeRows"?Promise.reject(new Error("A newer row version was saved. Refresh before retrying.")):{draft:null});
  renderInbox(); fireEvent.click(await screen.findByRole("button",{name:"Open"}));
  fireEvent.change(await screen.findByLabelText("Review decision r1"),{target:{value:"ELIGIBLE"}});
  fireEvent.click(screen.getByLabelText(/I checked changed source values/));
  fireEvent.click(screen.getByRole("button",{name:"Save review & continue"}));
  await screen.findByText(/A newer row version was saved/);
  expect(screen.getByLabelText("Review decision r1")).toHaveValue("ELIGIBLE");
  expect(screen.queryByRole("button",{name:"Save payment & continue"})).toBeNull();
});

it("reopens a completed source review at the payment step and preserves payment input while viewing prior steps",async()=>{
  const source={...intake,needsReview:0};
  h.action.mockImplementation(async op=>op==="intakeWorkspace"?{intakes:[source],settlements:[],templates:[]}:op==="getStatementIntake"?{...detail,intake:source,rows:[{...row,reviewStatus:"ELIGIBLE"}]}:{draft:null});
  renderInbox();fireEvent.click(await screen.findByRole("button",{name:"Open"}));
  const amount=await screen.findByLabelText("Agency commission received / retained ($)");
  expect(amount).toBeVisible();
  fireEvent.change(amount,{target:{value:"1000.00"}});fireEvent.blur(amount);
  expect(amount).toHaveValue("$1,000.00");
  fireEvent.click(screen.getByRole("button",{name:"Step 1: Import source, complete"}));
  expect(amount).not.toBeVisible();
  fireEvent.click(screen.getByRole("button",{name:"Step 3: Carrier payment, current"}));
  expect(amount).toHaveValue("$1,000.00");
  expect(amount).toBeVisible();
  expect(screen.getByRole("button",{name:"Step 4: Post earnings, up next"})).toBeDisabled();
});

it("requires the statement total to reconcile before advancing even when every row is reviewed",async()=>{
  const source={...intake,totalCents:20000,needsReview:0};
  h.action.mockImplementation(async op=>op==="intakeWorkspace"?{intakes:[source],settlements:[],templates:[]}:op==="getStatementIntake"?{...detail,intake:source,rows:[{...row,reviewStatus:"ELIGIBLE"}]}:{draft:null});
  renderInbox();fireEvent.click(await screen.findByRole("button",{name:"Open"}));
  expect(await screen.findByText(/Check the statement control total above/)).toBeVisible();
  expect(screen.getByLabelText("Statement agency commission total ($)")).toBeVisible();
  expect(screen.getByRole("button",{name:"Step 3: Carrier payment, up next"})).toBeDisabled();
});


it("saves only a confirmed payment and advances to the settlement review",async()=>{
  let settlement: Record<string,unknown> | undefined;
  const source={...intake,needsReview:0};
  h.action.mockImplementation(async(op,input)=>{
    if(op==="intakeWorkspace")return {intakes:[source],settlements:settlement?[settlement]:[],templates:[]};
    if(op==="getStatementIntake")return {intake:source,rows:[{...row,reviewStatus:"ELIGIBLE"}],settlements:settlement?[settlement]:[]};
    if(op==="recordIntakeSettlement"){settlement={id:"s1",version:1,intakeId:intake.id,reference:input.reference,receivedOn:input.receivedOn,totalCents:input.totalCents,settlementType:"DEPOSIT",evidence:input.evidence,status:"RECORDED",allocations:[],statementIds:[],postedRows:[]};return {ok:true};}
    if(op==="previewIntakeSettlement")return {calculations:[],employeeCents:1000};
    return {draft:null};
  });
  renderInbox();fireEvent.click(await screen.findByRole("button",{name:"Open"}));
  fireEvent.change(await screen.findByLabelText("Deposit / settlement reference"),{target:{value:"TEST-PAYMENT"}});
  fireEvent.change(screen.getByLabelText("Actual commission receipt date"),{target:{value:"2026-10-03"}});
  const amount=screen.getByLabelText("Agency commission received / retained ($)");
  fireEvent.change(amount,{target:{value:"100"}});
  fireEvent.change(screen.getByLabelText("Payment evidence"),{target:{value:"Fictional bank receipt"}});
  const confirmation=screen.getByLabelText(/I verified that this settlement occurred/);
  fireEvent.click(confirmation);
  fireEvent.change(amount,{target:{value:"100.00"}});
  expect(confirmation).not.toBeChecked();
  expect(screen.getByRole("button",{name:"Save payment & continue"})).toBeDisabled();
  fireEvent.click(confirmation);fireEvent.click(screen.getByRole("button",{name:"Save payment & continue"}));
  await waitFor(()=>expect(h.action).toHaveBeenCalledWith("recordIntakeSettlement",expect.objectContaining({totalCents:10000,confirmed:true,receivedOn:"2026-10-03"})));
  await waitFor(()=>expect(screen.getByRole("heading",{name:"Review & post settlement"})).toHaveFocus());
  expect(screen.queryByRole("button",{name:"Save payment & continue"})).toBeNull();
  expect(h.action.mock.calls.some(([op])=>op==="postIntakeSettlement")).toBe(false);
});


it("allows an early carrier receipt while keeping source review and posting incomplete",async()=>{
  renderInbox();fireEvent.click(await screen.findByRole("button",{name:"Open"}));
  fireEvent.click(await screen.findByText("Carrier payment already received?"));
  fireEvent.click(screen.getByRole("button",{name:"Record received payment"}));
  expect(screen.getByLabelText("Agency commission received / retained ($)")).toBeVisible();
  expect(screen.getByText(/source review is still required before posting/)).toBeVisible();
  expect(screen.getByRole("button",{name:"Step 4: Post earnings, up next"})).toBeDisabled();
  expect(h.action.mock.calls.some(([op])=>["recordIntakeSettlement","postIntakeSettlement"].includes(op))).toBe(false);
});

it("opens posted work cleanly, carries its identity to payroll and shows saved receipts on an earlier step",async()=>{
  const source={...intake,needsReview:0,postedCents:10000,completedRows:1};
  const payment={id:"paid",version:2,reference:"TEST-RECEIPT",receivedOn:"2026-10-03",totalCents:10000,status:"POSTED",allocations:[{rowId:row.id,amountCents:10000}],statementIds:[],postedRows:[row.id]};
  h.action.mockImplementation(async op=>op==="intakeWorkspace"?{intakes:[source],settlements:[payment],templates:[]}:op==="getStatementIntake"?{intake:source,rows:[{...row,reviewStatus:"ELIGIBLE",postedCents:10000}],settlements:[payment]}:{draft:null});
  const navigate=vi.fn();
  render(<CommissionWorkflowContext.Provider value={{target:{tab:"statements",intakeId:"inbox"},navigate}}><CommissionIntake data={data} refreshLedger={vi.fn()} renderPolicySetup={()=>null} onAccessDenied={vi.fn()}/></CommissionWorkflowContext.Provider>);
  fireEvent.click(await screen.findByRole("button",{name:"Continue to payroll"}));
  expect(navigate).toHaveBeenCalledWith({tab:"payroll",intakeId:"inbox",intakeReference:"TEST-SOURCE"});
  expect(h.action.mock.calls.some(([op])=>op==="extractIntakeDocument")).toBe(false);
  expect(h.dirty.mock.calls.some(([dirty])=>dirty)).toBe(false);
  fireEvent.click(screen.getByRole("button",{name:"Step 4: Post earnings, complete"}));
  await waitFor(()=>expect(h.dirty.mock.calls.some(([dirty])=>dirty)).toBe(false));
  fireEvent.click(screen.getByRole("button",{name:"Step 3: Carrier payment, complete"}));
  expect(screen.getByText("Saved carrier receipts")).toBeVisible();
  expect(screen.queryByLabelText("Actual commission receipt date")).toBeNull();
  expect(screen.getByRole("button",{name:"Record another receipt"})).toBeVisible();
});
it("suggests only the unrecorded receipt balance and leaves date, evidence and approval to the user",async()=>{
  const source={...intake,needsReview:0,postedCents:4000};
  const payment={id:"partial",version:2,reference:"PARTIAL",receivedOn:"2026-10-03",totalCents:4000,status:"POSTED",allocations:[{rowId:row.id,amountCents:4000}],statementIds:[],postedRows:[row.id]};
  h.action.mockImplementation(async op=>op==="intakeWorkspace"?{intakes:[source],settlements:[payment],templates:[]}:op==="getStatementIntake"?{intake:source,rows:[{...row,reviewStatus:"ELIGIBLE",postedCents:4000}],settlements:[payment]}:{draft:null});
  renderInbox();fireEvent.click(await screen.findByRole("button",{name:"Open"}));
  expect(await screen.findByLabelText("Agency commission received / retained ($)")).toHaveValue("$60.00");
  expect(screen.getByLabelText("Actual commission receipt date")).toHaveValue("");
  expect(screen.getByLabelText("Payment evidence")).toHaveValue("");
  expect(screen.getByRole("button",{name:"Save payment & continue"})).toBeDisabled();
  expect(h.dirty.mock.calls.some(([dirty])=>dirty)).toBe(false);
  fireEvent.change(screen.getByLabelText("Agency commission received / retained ($)"),{target:{value:"50"}});
  expect(h.dirty).toHaveBeenLastCalledWith(true);
});

it('offers manual rows from an empty source without unlocking posting or confirming anything',async()=>{
  const source={...intake,rowCount:0,rowTotalCents:0,needsReview:0};
  h.action.mockImplementation(async op=>op==='intakeWorkspace'?{intakes:[source],settlements:[],templates:[]}:op==='getStatementIntake'?{intake:source,rows:[],settlements:[]}:{draft:null});
  renderInbox();fireEvent.click(await screen.findByRole('button',{name:'Open'}));
  fireEvent.click(await screen.findByRole('button',{name:'Enter source rows manually'}));
  fireEvent.click(await screen.findByRole('button',{name:'Add source row'}));
  expect(screen.getByText(/Each row still needs your review/)).toBeVisible();
  expect(screen.getByRole('button',{name:'Step 4: Post earnings, up next'})).toBeDisabled();
  expect(h.action.mock.calls.some(([op])=>['saveIntakeRows','postIntakeSettlement'].includes(op))).toBe(false);
});
it.each(['intakeWorkspace','getStatementIntake'])('forwards %s access denial to clear the parent ledger',async deniedOp=>{
  const denied=vi.fn(),error=new Error('Not authorized');
  const original=h.action.getMockImplementation()!;
  h.action.mockImplementation(async (...args)=>{if(args[0]===deniedOp)throw error;return original(...args);});
  render(<CommissionIntake data={data} refreshLedger={vi.fn()} renderPolicySetup={()=>null} onAccessDenied={denied}/>);
  if(deniedOp==='getStatementIntake')fireEvent.click(await screen.findByRole('button',{name:'Open'}));
  await waitFor(()=>expect(denied).toHaveBeenCalledWith(error));
  expect(screen.queryByText('TEST-SOURCE')).toBeNull();
});
