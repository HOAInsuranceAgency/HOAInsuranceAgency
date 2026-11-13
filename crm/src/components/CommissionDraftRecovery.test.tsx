import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { StatementIntake } from "../../../shared/commissionIntake";
const h = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock("../lib/commissions", () => ({ commissionAction: h.action }));
import CommissionDraftRecovery from "./CommissionDraftRecovery";
const intake = { id: "inbox", version: 3 } as StatementIntake;
beforeEach(() => { vi.resetAllMocks(); });
it("saves a server working copy separately from eligibility and posting", async () => {
  h.action.mockResolvedValue({ draft: null });
  render(<CommissionDraftRecovery intake={intake} scope="rows" value={{ amount: "12.50" }} restore={vi.fn()} onError={vi.fn()} />);
  const button = await screen.findByRole("button", { name: "Save working draft" });
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.click(button);
  await waitFor(() => expect(h.action).toHaveBeenCalledWith("saveIntakeWorkingDraft", {
    id:"inbox", scope:"rows", version:0, baseVersion:3, data:{ amount:"12.50" },
  }));
  expect(h.action.mock.calls.every(([op]) => ["getIntakeWorkingDraft","saveIntakeWorkingDraft"].includes(op))).toBe(true);
});
it("restores the saved values only after an explicit recovery action", async () => {
  h.action.mockResolvedValue({ draft: { version:2, baseVersion:3, savedAt:"2026-11-13T12:00:00Z", data:{ amount:"12.50" } } });
  const restore = vi.fn();
  render(<CommissionDraftRecovery intake={intake} scope="rows" value={{ amount:"" }} restore={restore} onError={vi.fn()} />);
  const button = await screen.findByRole("button", { name:"Restore saved draft" });
  expect(restore).not.toHaveBeenCalled();
  fireEvent.click(button);
  expect(restore).toHaveBeenCalledWith({ amount:"12.50" });
});
it("retains stale values for comparison while blocking direct restoration", async () => {
  h.action.mockResolvedValue({ draft: { version:2, baseVersion:1, savedAt:"2026-11-13T12:00:00Z", data:{ amount:"12.50" } } });
  render(<CommissionDraftRecovery intake={intake} scope="rows" value={{ amount:"" }} restore={vi.fn()} onError={vi.fn()} />);
  expect(await screen.findByRole("button", { name:"Restore saved draft" })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("statement changed");
  expect(screen.getByText("12.50")).toBeInTheDocument();
});

it("can reload recovery data after a rejected save without silently retrying it",async()=>{
  h.action.mockImplementation(async op=>{if(op==="saveIntakeWorkingDraft")throw new Error("This statement changed");return{draft:null}});
  render(<CommissionDraftRecovery intake={intake} scope="rows" value={{amount:"12.50"}} restore={vi.fn()} onError={vi.fn()} />);
  const button=await screen.findByRole("button",{name:"Save working draft"});
  await waitFor(()=>expect(button).not.toBeDisabled());
  fireEvent.click(button);
  fireEvent.click(await screen.findByRole("button",{name:"Reload saved draft"}));
  await waitFor(()=>expect(h.action.mock.calls.filter(([op])=>op==="getIntakeWorkingDraft")).toHaveLength(2));
  expect(h.action.mock.calls.filter(([op])=>op==="saveIntakeWorkingDraft")).toHaveLength(1);
});

it("autosaves only edited working values after a pause without approving anything",async()=>{
  h.action.mockImplementation(async(op,input)=>op==='getIntakeWorkingDraft'?{draft:null}:{draft:{...input,version:1,savedAt:'2026-11-13T12:00:00Z'}});
  const restore=vi.fn(),onError=vi.fn();
  const view=render(<CommissionDraftRecovery intake={intake} scope="rows" value={{amount:""}} restore={restore} onError={onError}/>);
  await waitFor(()=>expect(screen.getByRole('button',{name:'Save working draft'})).toBeEnabled());
  expect(h.action.mock.calls.some(([op])=>op==='saveIntakeWorkingDraft')).toBe(false);
  view.rerender(<CommissionDraftRecovery intake={intake} scope="rows" value={{amount:"12"}} restore={restore} onError={onError}/>);
  view.rerender(<CommissionDraftRecovery intake={intake} scope="rows" value={{amount:"12.50"}} restore={restore} onError={onError}/>);
  await waitFor(()=>expect(h.action).toHaveBeenCalledWith('saveIntakeWorkingDraft',expect.objectContaining({data:{amount:'12.50'}})),{timeout:2500});
  expect(h.action.mock.calls.filter(([op])=>op==='saveIntakeWorkingDraft')).toHaveLength(1);
});
it("does not autosave over an unrecovered working copy",async()=>{
  h.action.mockResolvedValue({draft:{version:2,baseVersion:3,savedAt:'2026-11-13T12:00:00Z',data:{amount:'old'}}});
  const view=render(<CommissionDraftRecovery intake={intake} scope="rows" value={{amount:""}} restore={vi.fn()} onError={vi.fn()}/>);
  await screen.findByRole('button',{name:'Restore saved draft'});
  view.rerender(<CommissionDraftRecovery intake={intake} scope="rows" value={{amount:"new"}} restore={vi.fn()} onError={vi.fn()}/>);
  await new Promise(resolve=>setTimeout(resolve,1100));
  expect(h.action.mock.calls.some(([op])=>op==='saveIntakeWorkingDraft')).toBe(false);
});
