import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { calculateEmployeeProfitability, type EmployeeCompensation } from "../../../shared/employeeProfitability";

const h = vi.hoisted(() => ({ owner: true, query: vi.fn(), save: vi.fn(), download: vi.fn() }));
vi.mock("../lib/auth", () => ({ useIsOwner: () => h.owner }));
vi.mock("../lib/client", () => ({ client: { queries: { ownerProfitability: h.query }, mutations: { saveEmployeeCompensation: h.save } }, friendlyError: (error: Error) => error.message }));
vi.mock("../lib/reportDownload", () => ({ saveReport: h.download }));
import OwnerProfitability from "./OwnerProfitability";

const employees = [{ userId: "jake", name: "Jake Greasley", salesperson: true }, { userId: "casey", name: "Casey Staff", salesperson: false }];
const compensation: EmployeeCompensation = { userId: "jake", version: 3, terms: [{ from: "2026-01-01", annualSalaryCents: 6_000_000, producerShareBps: 2500 }] };
function snapshot(partial = false) {
  const compensations: Record<string, EmployeeCompensation> = { jake: compensation, ...(!partial ? { casey: { userId: "casey", version: 1, terms: [{ from: "2026-01-01", annualSalaryCents: 0, producerShareBps: 0 }] } } : {}) };
  const report = calculateEmployeeProfitability({ from: "2026-01-01", to: "2026-12-31", employees, compensations, assignments: { a: { salespersonId: "jake" }, b: { salespersonId: "casey" } }, policies: [{ id: "policy1", accountId: "a", effectiveDate: "2026-03-01", premium: 20_000, commissionPct: 10, status: "ACTIVE" }, ...(partial ? [{ id: "policy2", accountId: "b", effectiveDate: "2026-04-01", premium: 10_000, commissionPct: null, status: "ACTIVE" }] : [])] });
  return { ok: true, employees, compensations, report };
}
beforeEach(() => { vi.clearAllMocks(); h.owner = true; h.query.mockResolvedValue({ data: snapshot() }); h.save.mockResolvedValue({ data: { ok: true, compensation: { ...compensation, version: 4 } } }); });
async function openPay() { fireEvent.click(await screen.findByRole("button", { name: "Manage pay settings" })); }

describe("owner profitability privacy and report", () => {
  it("does not request private data outside the Owner role", () => {
    h.owner = false; render(<OwnerProfitability />);
    expect(screen.getByRole("alert")).toHaveTextContent("Switch to the Owner role");
    expect(h.query).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Employee profitability" })).toBeNull();
  });
  it("removes private values immediately when the Owner role is left", async () => {
    const view = render(<OwnerProfitability />);
    expect(await screen.findByRole("table")).toBeVisible();
    h.owner = false; view.rerender(<OwnerProfitability />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("-$58,500.00")).toBeNull();
    expect(h.query).toHaveBeenCalledTimes(1);
  });
  it("shows negative contribution and identifies the calculation basis", async () => {
    render(<OwnerProfitability />);
    const table = await screen.findByRole("table");
    const row = within(table).getByRole("row", { name: /Jake Greasley/ });
    expect(within(row).getByText("-$58,500.00")).toHaveClass("owner-profitability-negative");
    expect(screen.getByLabelText("Report calculation basis")).toHaveTextContent("policy effective date and current account salesperson");
    expect(screen.getByLabelText("Report calculation basis")).toHaveTextContent("other operating costs are excluded");
    expect(screen.getByLabelText("Net revenue compared with salary by employee")).toHaveTextContent("$1,500.00");
    expect(h.query).toHaveBeenCalledWith({ from: expect.stringMatching(/^\d{4}-01-01$/), to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });
  it("keeps incomplete amounts unknown and exports their status and date basis", async () => {
    h.query.mockResolvedValue({ data: JSON.stringify(snapshot(true)) });
    render(<OwnerProfitability />);
    const table = await screen.findByRole("table");
    expect(screen.getByRole("status")).toHaveTextContent("Missing commission or pay details are not treated as zero");
    const row = within(table).getByRole("row", { name: /Casey Staff/ });
    expect(within(row).getByText("Needs pay setup")).toBeVisible();
    expect(within(row).getAllByText("Incomplete")).toHaveLength(5);
    expect(within(row).queryByText("$0.00")).toBeNull();
    const total = screen.getByText("Agency commission", { selector: ".l" }).closest(".stat")!;
    expect(total).toHaveTextContent("Incomplete"); expect(total).toHaveTextContent("$2,000.00 known · partial");
    fireEvent.change(screen.getByRole("combobox", { name: "Download Estimated employee profitability" }), { target: { value: "csv" } });
    const report = h.download.mock.calls[0][0];
    expect(report.filters).toContain("policy effective date and current account salesperson");
    expect(report.filters).toContain("INCOMPLETE");
    expect(report.sections[0].rows.find((r: unknown[]) => r[0] === "Casey Staff")).toEqual(["Casey Staff", null, null, null, null, null, 1, "No", 1, 1, expect.any(String)]);
    fireEvent.click(within(row).getByRole("button", { name: "Edit pay settings for Casey Staff" }));
    expect(screen.getByRole("combobox", { name: "Employee" })).toHaveValue("casey");
  });
  it("clears the prior report on refresh failure instead of exposing stale salary data", async () => {
    render(<OwnerProfitability />); await screen.findByRole("table");
    h.query.mockResolvedValue({ data: null, errors: [{ message: "Owner access is no longer available" }] });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Owner access is no longer available");
    expect(screen.queryByRole("table")).toBeNull(); expect(screen.queryByRole("combobox", { name: /Download/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });
  it("does not export an old report under new period dates", async () => {
    render(<OwnerProfitability />); await screen.findByRole("table");
    let finish!: (value: unknown) => void;
    h.query.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    fireEvent.change(screen.getByLabelText("Report from"), { target: { value: "2025-01-01" } });
    fireEvent.change(screen.getByLabelText("Report through"), { target: { value: "2025-12-31" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply dates" }));
    expect(screen.queryByRole("table")).toBeNull(); expect(screen.queryByRole("combobox", { name: /Download/ })).toBeNull();
    await waitFor(() => expect(h.query).toHaveBeenLastCalledWith({ from: "2025-01-01", to: "2025-12-31" }));
    await act(async () => finish({ data: { ...snapshot(), report: { ...snapshot().report, from: "2025-01-01", to: "2025-12-31" } } }));
    expect(screen.getByText("2025-01-01 through 2025-12-31 · USD · Estimated")).toBeVisible();
  });
});

describe("private employee compensation editor", () => {
  it("converts dollars and percent exactly, sends the committed version, and refreshes the report", async () => {
    render(<OwnerProfitability />); await openPay();
    expect(screen.getByRole("region", { name: "Private pay settings" })).toHaveFocus();
    expect(screen.getByRole("option", { name: "Casey Staff" })).toBeInTheDocument();
    expect(screen.getByLabelText("Annual salary 1")).toHaveValue("60000.00");
    expect(screen.getByLabelText("Commission share 1")).toHaveValue("25.00");
    fireEvent.change(screen.getByLabelText("Annual salary 1"), { target: { value: "72000.50" } });
    fireEvent.change(screen.getByLabelText("Commission share 1"), { target: { value: "12.25" } });
    h.query.mockResolvedValue({ data: { ...snapshot(), compensations: { ...snapshot().compensations, jake: { ...compensation, version: 4, terms: [{ from: "2026-01-01", annualSalaryCents: 7_200_050, producerShareBps: 1225 }] } } } });
    fireEvent.click(screen.getByRole("button", { name: "Save pay settings" }));
    await waitFor(() => expect(h.save).toHaveBeenCalledWith({ userId: "jake", version: 3, terms: JSON.stringify([{ from: "2026-01-01", annualSalaryCents: 7_200_050, producerShareBps: 1225 }]) }));
    await waitFor(() => expect(h.query).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Pay settings saved.")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Annual salary 1"), { target: { value: "73000" } });
    expect(screen.queryByText("Pay settings saved.")).toBeNull();
  });
  it.each(["", "-1", "12.345", "1e5"])("rejects invalid salary %j without writing", async salary => {
    render(<OwnerProfitability />); await openPay();
    fireEvent.change(screen.getByLabelText("Annual salary 1"), { target: { value: salary } });
    fireEvent.submit(screen.getByRole("form", { name: "Pay settings for Jake Greasley" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter annual salary"); expect(h.save).not.toHaveBeenCalled();
  });
  it("rejects overlapping periods and out-of-range shares", async () => {
    render(<OwnerProfitability />); await openPay();
    fireEvent.change(screen.getByLabelText("Commission share 1"), { target: { value: "100.01" } });
    fireEvent.submit(screen.getByRole("form", { name: "Pay settings for Jake Greasley" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter valid compensation");
    fireEvent.change(screen.getByLabelText("Commission share 1"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "Add pay period" }));
    fireEvent.change(screen.getByLabelText("Start date 2"), { target: { value: "2026-07-01" } });
    fireEvent.change(screen.getByLabelText("Annual salary 2"), { target: { value: "80000" } });
    fireEvent.change(screen.getByLabelText("Commission share 2"), { target: { value: "25" } });
    fireEvent.submit(screen.getByRole("form", { name: "Pay settings for Jake Greasley" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("date ranges cannot overlap"); expect(h.save).not.toHaveBeenCalled();
  });
  it("keeps a failed save editable and preserves the version for a retry", async () => {
    h.save.mockResolvedValue({ data: { ok: false, error: "Pay settings changed. Refresh before saving." } });
    render(<OwnerProfitability />); await openPay();
    fireEvent.change(screen.getByLabelText("Annual salary 1"), { target: { value: "70000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save pay settings" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Pay settings changed");
    expect(screen.getByLabelText("Annual salary 1")).toHaveValue("70000");
    expect(screen.getByRole("button", { name: "Save pay settings" })).toBeEnabled();
    expect(h.query).toHaveBeenCalledTimes(1);
  });
});

it('blocks manual refresh while pay settings are open and keeps a dirty draft intact', async () => {
  render(<OwnerProfitability />); await openPay();
  fireEvent.change(screen.getByLabelText('Annual salary 1'), { target: { value: '71000' } });
  h.query.mockRejectedValue(new Error('Report temporarily unavailable'));
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(h.query).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Annual salary 1')).toHaveValue('71000');
  fireEvent.click(screen.getByRole('button', { name: 'Manage pay settings' }));
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Report temporarily unavailable');
  expect(screen.queryByRole('table')).toBeNull();
  expect(screen.queryByRole('region', { name: 'Private pay settings' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
});

it('prevents starting pay edits while a report refresh may clear private data', async () => {
  h.query.mockResolvedValueOnce({ data: snapshot(true) });
  render(<OwnerProfitability />); await screen.findByRole('table');
  let fail!: (error: Error) => void;
  h.query.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  const manage = screen.getByRole('button', { name: 'Manage pay settings' });
  const setup = screen.getByRole('button', { name: 'Edit pay settings for Casey Staff' });
  expect(manage).toBeDisabled(); expect(setup).toBeDisabled();
  fireEvent.click(manage); fireEvent.click(setup);
  expect(screen.queryByRole('region', { name: 'Private pay settings' })).toBeNull();
  await act(async () => fail(new Error('Report temporarily unavailable')));
  expect(screen.getByRole('alert')).toHaveTextContent('Report temporarily unavailable');
  expect(screen.queryByRole('table')).toBeNull();
});


it('keeps an in-flight pay save attached to its employee and adopts the committed version before rereads catch up', async () => {
  let finish!: (value: unknown) => void;
  h.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<OwnerProfitability />); await openPay();
  fireEvent.change(screen.getByLabelText('Annual salary 1'), { target: { value: '71000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save pay settings' }));
  expect(screen.getByRole('button', { name: 'Manage pay settings' })).toBeDisabled();
  expect(screen.getByRole('combobox', { name: 'Employee' })).toBeDisabled();
  const committed = { ...compensation, version: 4, terms: [{ ...compensation.terms[0], annualSalaryCents: 7_100_000 }] };
  await act(async () => finish({ data: { ok: true, compensation: committed } }));
  await screen.findByText('Pay settings saved.');
  expect(screen.getByLabelText('Annual salary 1')).toHaveValue('71000.00');
  fireEvent.change(screen.getByLabelText('Annual salary 1'), { target: { value: '72000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save pay settings' }));
  await waitFor(() => expect(h.save).toHaveBeenCalledTimes(2));
  expect(h.save).toHaveBeenLastCalledWith(expect.objectContaining({ version: 4 }));
});
