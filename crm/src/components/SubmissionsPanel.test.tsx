import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { Account } from "../lib/client";
const h = vi.hoisted(() => ({ list: vi.fn(), estimates: vi.fn(), settings: vi.fn(), start: vi.fn(), resolve: vi.fn() }));
vi.mock("../lib/client", () => ({ client: { models: { HoneycombSubmission: { listHoneycombSubmissionByAccountId: h.list }, HoneycombEstimate: { listHoneycombEstimateByAccountId: h.estimates } }, queries: { honeycombSubmissionSettings: h.settings }, mutations: { startHoneycombSubmission: h.start, resolveHoneycombSubmission: h.resolve } }, friendlyError: (e: Error) => e.message }));
import SubmissionsPanel, { initialDetails } from "./SubmissionsPanel";
import { businessDate } from "../../amplify/functions/honeycomb/submission-contract";
const account = { id: "account", name: "Example Association", type: "ASSOCIATION", stage: "LEAD", address: "9 Changed St", city: "Chicago", state: "IL", zip: "60601", unitCount: 12, totalInsuredValue: 9000000, currentPolicyExpiration: businessDate() } as Account;
const estimate = { id: "estimate", accountId: "account", status: "READY", price: 1234, estimationId: "carrier-id", createdAt: "2026-09-23T12:00:00Z", input: JSON.stringify({ address: "1 Original St, Chicago, IL", submissionData: { buildingType: "condominium", grossSQFeet: 15000, replacementValue: 2500000, numUnits: 12 } }), result: '{"isOkToSubmit":true}' };
const job = { id: "job", accountId: "account", effectiveDate: businessDate(), status: "PENDING", attempt: 1, input: JSON.stringify({ address: "Address", submissionData: { effectiveDate: businessDate(), nameInsured: "Example Association" } }), requestedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
beforeEach(() => {
  vi.clearAllMocks(); h.list.mockResolvedValue({ data: [] }); h.estimates.mockResolvedValue({ data: [estimate] }); h.settings.mockResolvedValue({ data: { enabled: true } });
  h.start.mockImplementation(async () => { h.list.mockResolvedValue({ data: [job] }); return { data: JSON.stringify({ ok: true, id: "job", status: "PENDING" }) }; }); h.resolve.mockResolvedValue({ data: { ok: true } });
});
afterEach(() => vi.useRealTimers());
it("prefills account fields while leaving replacement cost unconfirmed", () => {
  expect(initialDetails(account)).toMatchObject({ nameInsured: "Example Association", address: "9 Changed St, Chicago, IL, 60601", numUnits: 12 });
  expect(initialDetails(account).replacementValue).toBeUndefined(); expect(initialDetails(account).buildingType).toBeUndefined();
});
it("converts a website estimate with locked original inputs and explicit agent review", async () => {
  render(<SubmissionsPanel account={account} initialEstimateId="estimate" />);
  await screen.findByRole("form", { name: "Review Honeycomb submission" });
  expect(screen.getByLabelText("Full property address *")).toHaveValue("1 Original St, Chicago, IL"); expect(screen.getByLabelText("Full property address *")).toHaveAttribute("readonly");
  expect(screen.getByLabelText("Building replacement cost ($)")).toHaveValue("2,500,000"); expect(screen.getByLabelText("Total building area (sq ft)")).toHaveAttribute("readonly");
  expect(screen.getByRole("button", { name: "Create partial submission" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.submit(screen.getByRole("form")); fireEvent.submit(screen.getByRole("form"));
  await screen.findByText("Queued"); expect(h.start).toHaveBeenCalledTimes(1);
  const sent = h.start.mock.calls[0][0]; expect(sent).toMatchObject({ accountId: "account", sourceEstimateId: "estimate", reviewed: true }); expect(JSON.parse(sent.details)).toMatchObject({ address: "1 Original St, Chicago, IL", replacementValue: 2500000 });
});
it("pages through estimates and excludes ineligible ones", async () => {
  h.estimates.mockResolvedValueOnce({ data: [{ ...estimate, id: "declined", status: "DECLINED" }], nextToken: "page2" }).mockResolvedValue({ data: [estimate] });
  render(<SubmissionsPanel account={account} />); await screen.findByLabelText("Start from");
  expect(h.estimates).toHaveBeenCalledWith({ accountId: "account" }, { nextToken: "page2" }); expect(screen.getAllByRole("option").map(o => (o as HTMLOptionElement).value)).not.toContain("declined");
});
it("submits unlinked property details and removes review confirmation after an edit", async () => {
  render(<SubmissionsPanel account={account} />); await screen.findByLabelText("Start from");
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.change(screen.getByLabelText("Legal insured name *"), { target: { value: "Revised Association" } }); expect(screen.getByRole("checkbox")).not.toBeChecked();
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.submit(screen.getByRole("form")); await screen.findByText("Queued");
  expect(h.start.mock.calls[0][0].sourceEstimateId).toBeUndefined(); expect(JSON.parse(h.start.mock.calls[0][0].details).replacementValue).toBeUndefined();
});
it("closes an empty composer when canceled", async () => {
  render(<SubmissionsPanel account={account} />); await screen.findByRole("form"); fireEvent.click(screen.getByRole("button", { name: "Cancel" })); expect(screen.queryByRole("form")).toBeNull();
});
it("does not allow creation when lists fail or staging is disabled", async () => {
  h.list.mockResolvedValue({ data: [], errors: [{ message: "denied" }] }); const view = render(<SubmissionsPanel account={account} />); await screen.findByRole("alert"); expect(screen.queryByRole("form")).toBeNull(); view.unmount();
  h.list.mockResolvedValue({ data: [] }); h.settings.mockResolvedValue({ data: { enabled: false } }); render(<SubmissionsPanel account={account} />); await screen.findByText("Honeycomb submissions are currently enabled in staging only."); expect(screen.queryByRole("form")).toBeNull();
});
it("shows a timeout review path rather than an automatic retry", async () => {
  h.list.mockResolvedValue({ data: [{ ...job, status: "RUNNING", updatedAt: new Date(Date.now()-130000).toISOString() }] }); render(<SubmissionsPanel account={account} />);
  await screen.findByText("Check Honeycomb before retrying"); expect(screen.queryByRole("button", { name: "Review and retry" })).toBeNull();
  fireEvent.click(screen.getByText("Record portal review")); fireEvent.change(screen.getByLabelText("Submission ID from Honeycomb portal URL"), { target: { value: "found" } }); fireEvent.change(screen.getByLabelText("Review note"), { target: { value: "Found in portal" } });
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Save review outcome" })); await waitFor(() => expect(h.resolve).toHaveBeenCalledWith({ id: "job", outcome: "LINK_EXISTING", submissionId: "found", note: "Found in portal", reviewed: true })); expect(h.start).not.toHaveBeenCalled();
});
it("loads rejected input for explicit retry and preserves the term", async () => {
  h.list.mockResolvedValue({ data: [{ ...job, status: "REJECTED", issue: "HTTP_400" }] }); render(<SubmissionsPanel account={account} />); fireEvent.click(await screen.findByRole("button", { name: "Review and retry" }));
  expect(screen.getByLabelText("Effective date *")).toHaveAttribute("readonly"); fireEvent.click(screen.getByRole("checkbox")); fireEvent.submit(screen.getByRole("form")); await waitFor(() => expect(h.start).toHaveBeenCalledTimes(1)); expect(h.start.mock.calls[0][0].retryVersion).toBe(job.updatedAt);
});
it("polls queued submissions to a portal link and stops on unmount", async () => {
  vi.useFakeTimers(); h.list.mockResolvedValue({ data: [job] }); const view = render(<SubmissionsPanel account={account} />); await act(async () => {}); expect(screen.getByText("Queued")).toBeTruthy();
  h.list.mockResolvedValue({ data: [{ ...job, status: "CREATED", submissionId: "created", submissionStatus: "incomplete" }] }); await act(async () => { await vi.advanceTimersByTimeAsync(5000); }); expect(screen.getByRole("link", { name: /Open in Honeycomb/ })).toHaveAttribute("href", "https://staging-falcon.honeycombinsurance.com/quotes/created");
  const count = h.list.mock.calls.length; view.unmount(); await vi.advanceTimersByTimeAsync(15000); expect(h.list).toHaveBeenCalledTimes(count);
});
