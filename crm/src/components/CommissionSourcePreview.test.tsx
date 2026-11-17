import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StatementIntake } from "../../../shared/commissionIntake";
const action=vi.hoisted(()=>vi.fn());
vi.mock("../lib/commissions",()=>({commissionAction:action}));
import CommissionSourcePreview from "./CommissionSourcePreview";
afterEach(()=>{vi.unstubAllGlobals();vi.resetAllMocks();});
it("formats recognized source amounts without changing numeric policy identifiers or invalid precision",async()=>{
  const csv="Policy,Reference,Amount\n1000,R1,1000.00\n500,R2,-25.25\n600,R3,12.345";
  action.mockResolvedValue({url:"https://example.test/source"});
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:true,text:async()=>csv}));
  render(<CommissionSourcePreview intake={{id:"i",source:"s",filename:"source.csv"} as StatementIntake} onError={vi.fn()} />);
  fireEvent.click(screen.getByRole("button",{name:"Show original"}));
  await waitFor(()=>expect(screen.getByText("$1,000.00")).toBeVisible());
  expect(screen.getByText("($25.25)")).toBeVisible();
  expect(screen.getByText("12.345")).toBeVisible();
  expect(screen.getByText("1000")).toBeVisible();
  expect(action).toHaveBeenCalledTimes(1);
  expect(action).toHaveBeenCalledWith("file",{key:"s"});
});
it("leaves ambiguous source amount columns unchanged",async()=>{
  action.mockResolvedValue({url:"https://example.test/source"});
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:true,text:async()=>"Policy,Amount,Amount\nPOL-1,1000.00,500.00"}));
  render(<CommissionSourcePreview intake={{id:"i",source:"s",filename:"source.csv"} as StatementIntake} onError={vi.fn()} />);
  fireEvent.click(screen.getByRole("button",{name:"Show original"}));
  expect(await screen.findByText("1000.00")).toBeVisible();
  expect(screen.getByText("500.00")).toBeVisible();
});
