import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StatementIntake } from "../../../shared/commissionIntake";
const action=vi.hoisted(()=>vi.fn());
vi.mock("../lib/commissions",()=>({commissionWorkflowAction:action}));
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
  expect(action).toHaveBeenCalledWith("file",{key:"s",preview:true});
});
it("leaves ambiguous source amount columns unchanged",async()=>{
  action.mockResolvedValue({url:"https://example.test/source"});
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:true,text:async()=>"Policy,Amount,Amount\nPOL-1,1000.00,500.00"}));
  render(<CommissionSourcePreview intake={{id:"i",source:"s",filename:"source.csv"} as StatementIntake} onError={vi.fn()} />);
  fireEvent.click(screen.getByRole("button",{name:"Show original"}));
  expect(await screen.findByText("1000.00")).toBeVisible();
  expect(screen.getByText("500.00")).toBeVisible();
});

it("does not fetch or embed a statement on a wide screen or after navigation", async () => {
  const media = {matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()};
  vi.stubGlobal('matchMedia',vi.fn(()=>media));
  action.mockResolvedValue({url:'https://example.test/inline',previewable:true});
  const props = {intake:{id:'i',source:'s',filename:'statement.pdf'} as StatementIntake,onError:vi.fn()};
  const first = render(<CommissionSourcePreview {...props}/>);
  expect(action).not.toHaveBeenCalled();
  expect(document.querySelector('iframe')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Show original'}));
  await waitFor(()=>expect(screen.getByTitle('Original carrier statement')).toHaveAttribute('src','https://example.test/inline'));
  expect(action).toHaveBeenCalledTimes(1);
  expect(media.addEventListener).not.toHaveBeenCalled();
  first.unmount();
  render(<CommissionSourcePreview {...props}/>);
  expect(document.querySelector('iframe')).toBeNull();
  expect(action).toHaveBeenCalledTimes(1);
});
it('never embeds a download-only response as a PDF',async()=>{
  action.mockResolvedValue({url:'https://example.test/download',previewable:false});
  render(<CommissionSourcePreview intake={{id:'i',source:'s',filename:'statement.pdf'} as StatementIntake} onError={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'Show original'}));
  expect(await screen.findByRole('link',{name:'Open complete original'})).toHaveAttribute('href','https://example.test/download');
  expect(document.querySelector('iframe')).toBeNull();
});
