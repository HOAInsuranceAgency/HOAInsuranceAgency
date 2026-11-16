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
