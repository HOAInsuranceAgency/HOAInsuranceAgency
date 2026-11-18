import { expect, it } from "vitest";
import { sourcePayrollHandoff } from "./commissionPayrollHandoff";
import { payrollRowKey, type PayrollWorkspace } from "../../../shared/commissionPayroll";
const receipt = { policyId:"policy",entryId:"r1",producerId:"brian",receivedOn:"2026-11-11",amountCents:10000 };
const shared = {...receipt,earningId:"shared-1",source:"SHARED_RECEIPT"};
const keys = [receipt,shared].map(payrollRowKey);
function fixture() { return {sourceLinks:[{intakeId:"source",statementId:"s",policyId:"policy",entryId:"r1"}],availableEarnings:[receipt,shared,{...receipt,entryId:"unrelated"},{...receipt,earningId:"adjustment",source:"ADJUSTMENT"}],batches:[],cycles:[{id:"2026-11-OFF-old",cycleType:"OFF_CYCLE",status:"OPEN",cutoff:"2026-11-12",batchIds:[]},{id:"2026-11",status:"OPEN",cutoff:"2026-11-20",batchIds:[]}]} as unknown as PayrollWorkspace; }
it("carries only exact linked receipts and shared earnings, keeping unrelated employee earnings and adjustments separate",()=>{
 const result=sourcePayrollHandoff(fixture(),"source");
 expect(result.keys).toEqual(keys);expect(result.available.map(e=>e.amountCents)).toEqual([10000,10000]);
 expect(result.linkedCycles).toEqual([]);expect(result.monthly?.id).toBe("2026-11");
 expect(sourcePayrollHandoff(fixture(),"missing").keys).toEqual([]);
});
it("recognizes an exact draft without adopting an employee-wide or superset draft",()=>{
 const workspace=fixture();const base=workspace.cycles[0];
 workspace.cycles.push({...base,id:"exact",selectedEarningKeys:keys},{...base,id:"superset",selectedEarningKeys:[...keys,'unrelated']});
 expect(sourcePayrollHandoff(workspace,"source").linkedCycles.map(c=>c.id)).toEqual(["exact"]);
});
it("follows current batches for assigned earnings and ignores cancelled or replaced reservations",()=>{
 const workspace=fixture();workspace.availableEarnings=[];
 workspace.batches=[{id:"batch",cycleId:"current",status:"APPROVED",lines:[receipt]},{id:"old",cycleId:"cancelled",status:"CANCELLED",lines:[receipt]},{id:"replaced",cycleId:"current",status:"APPROVED",lines:[receipt]}] as unknown as PayrollWorkspace['batches'];
 workspace.cycles=[{...workspace.cycles[0],id:"current",status:"APPROVED",batchIds:["batch"]},{...workspace.cycles[0],id:"cancelled",status:"CANCELLED",batchIds:["old"]}];
 const result=sourcePayrollHandoff(workspace,"source");expect(result.keys).toEqual([]);expect(result.linkedCycles.map(c=>c.id)).toEqual(["current"]);
});
