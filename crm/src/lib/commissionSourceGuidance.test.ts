import { expect, it } from "vitest";
import { displayCommissionAmount, suggestImportMapping } from "./commissionSourceGuidance";
import type { CarrierImportTemplate } from "../../../shared/commissionIntake";
it("leaves duplicate, unfamiliar and competing amount headings for explicit review",()=>{
  expect(suggestImportMapping(["Policy","Policy #","Reference","Amount","Commission Amount","Effective","Transaction"])).toEqual({policy:-1,reference:2,amount:-1,effective:5,transaction:6});
  expect(suggestImportMapping(["Policy","Reference","Premium","Date","Status"])).toEqual({policy:0,reference:1,amount:-1,effective:-1,transaction:-1});
});
it("reuses saved carrier choices including deliberately omitted columns",()=>{
  const template={headers:["Policy","Reference","Amount","Effective","Transaction"],mapping:{policy:0,reference:1,amount:2,effective:-1,transaction:-1}} as CarrierImportTemplate;
  expect(suggestImportMapping(["Transaction","Amount","Reference","Policy","Effective"],template)).toEqual({policy:3,reference:2,amount:1,effective:-1,transaction:-1});
});
it.each([["1500","$1,500.00"],["0","$0.00"],["-25.25","($25.25)"],["($1,500.00)","($1,500.00)"],["12.345","12.345"],["1e3","1e3"],["",""],["1,5","1,5"]])("shows %s as %s without silently correcting money",(raw,shown)=>expect(displayCommissionAmount(raw)).toBe(shown));
