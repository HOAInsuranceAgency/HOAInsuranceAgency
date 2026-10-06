import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const models = vi.hoisted(() => ({
  Policy: { list: vi.fn(), update: vi.fn() },
  Carrier: { list: vi.fn() },
}));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models }) }));
vi.mock("aws-amplify/auth", () => ({ getCurrentUser: async () => ({ userId: "staff" }) }));
vi.mock("../../components/QuotesPanel", () => ({ commissionCell: () => "—", termsSummary: () => "—" }));
vi.mock("../../components/CoverageForm", () => ({
  default: ({ accountId, existing, onSaved, onCancel }: {
    accountId: string; existing: { id: string }; onSaved: () => void; onCancel: () => void;
  }) => <div role="dialog" aria-label={`Edit ${existing.id} on ${accountId}`}>
    <input aria-label="Policy draft" defaultValue="Draft" />
    <button onClick={onSaved}>Save changes</button>
    <button onClick={onCancel}>Cancel</button>
  </div>,
}));

import { PoliciesTab } from "./PoliciesTab";

const policy = { id: "p1", accountId: "a1", carrierId: "c2", policyNumber: "HOA-1", status: "ACTIVE" };
beforeEach(() => {
  vi.resetAllMocks();
  models.Policy.list.mockResolvedValue({ data: [policy] });
  models.Carrier.list.mockResolvedValue({ data: [{ id: "c2", name: "Later Carrier" }] });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe("policy reliability", () => {
  it("loads all carrier pages and retries a failed page before editing", async () => {
    models.Carrier.list.mockResolvedValueOnce({ data: [{ id: "c1", name: "First" }], nextToken: "page-2" })
      .mockResolvedValueOnce({ data: [], errors: [{ message: "Carrier read failed" }] })
      .mockResolvedValueOnce({ data: [{ id: "c1", name: "First" }], nextToken: "page-2" })
      .mockResolvedValueOnce({ data: [{ id: "c2", name: "Later Carrier" }] });
    render(<PoliciesTab accountId="a1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Carrier read failed");
    expect(screen.getByText("HOA-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Retry carriers" }));
    expect(await screen.findByText("Later Carrier")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
    expect(models.Carrier.list).toHaveBeenNthCalledWith(4, { nextToken: "page-2" });
  });

  it("keeps policies visible through a failed post-save refresh and offers a read retry", async () => {
    models.Policy.list.mockResolvedValueOnce({ data: [policy] })
      .mockResolvedValueOnce({ data: [], errors: [{ message: "Policy read failed" }] })
      .mockResolvedValueOnce({ data: [{ ...policy, policyNumber: "HOA-Updated" }] });
    render(<PoliciesTab accountId="a1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Policy read failed");
    expect(screen.getByText("HOA-1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry policies" }));
    expect(await screen.findByText("HOA-Updated")).toBeInTheDocument();
    expect(models.Carrier.list).toHaveBeenCalledTimes(1);
  });

  it("does not show a false empty list after a policy read failure", async () => {
    models.Policy.list.mockResolvedValueOnce({ data: [], errors: [{ message: "Policy read failed" }] });
    render(<PoliciesTab accountId="a1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Policy read failed");
    expect(screen.queryByText(/No policies\./)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry policies" }));
    expect(await screen.findByText("HOA-1")).toBeInTheDocument();
  });

  it("resets the policy editor when the account changes and prevents competing edits", async () => {
    const view = render(<PoliciesTab accountId="a1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await userEvent.type(screen.getByLabelText("Policy draft"), " unsaved");
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    models.Policy.list.mockResolvedValue({ data: [{ ...policy, id: "p2", accountId: "a2", policyNumber: "HOA-2" }] });
    view.rerender(<PoliciesTab accountId="a2" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("HOA-1")).not.toBeInTheDocument();
    expect(await screen.findByText("HOA-2")).toBeInTheDocument();
  });

  it("blocks duplicate status writes and ignores their completion after an account switch", async () => {
    const pending = deferred<{ data: typeof policy }>();
    models.Policy.update.mockReturnValue(pending.promise);
    const view = render(<PoliciesTab accountId="a1" />);
    const select = await screen.findByRole("combobox");
    fireEvent.change(select, { target: { value: "CANCELLED" } });
    fireEvent.change(select, { target: { value: "EXPIRED" } });
    await waitFor(() => expect(models.Policy.update).toHaveBeenCalledTimes(1));
    expect(select).toBeDisabled();
    models.Policy.list.mockResolvedValue({ data: [{ ...policy, id: "p2", accountId: "a2", policyNumber: "HOA-2" }] });
    view.rerender(<PoliciesTab accountId="a2" />);
    expect(await screen.findByText("HOA-2")).toBeInTheDocument();
    await act(async () => pending.resolve({ data: { ...policy, status: "CANCELLED" } }));
    expect(screen.getByRole("combobox")).toHaveValue("ACTIVE");
    expect(screen.queryByText("Policy updated.")).not.toBeInTheDocument();
  });

  it("clears cached policy rows when refresh is denied", async () => {
    models.Policy.list.mockResolvedValueOnce({ data: [policy] })
      .mockResolvedValueOnce({ data: [], errors: [{ message: "Not authorized" }] });
    render(<PoliciesTab accountId="a1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("HOA-1")).not.toBeInTheDocument();
  });

  it("preserves independent row changes and shows a failure on the affected policy", async () => {
    const first = deferred<{ data: null; errors: { message: string }[] }>();
    models.Policy.list.mockResolvedValue({ data: [policy, { ...policy, id: "p2", policyNumber: "HOA-2" }] });
    models.Policy.update.mockImplementation(({ id }) => id === "p1" ? first.promise
      : Promise.resolve({ data: { ...policy, id: "p2", policyNumber: "HOA-2", status: "EXPIRED" } }));
    render(<PoliciesTab accountId="a1" />);
    fireEvent.change(await screen.findByLabelText("Status for policy HOA-1"), { target: { value: "CANCELLED" } });
    fireEvent.change(screen.getByLabelText("Status for policy HOA-2"), { target: { value: "EXPIRED" } });
    await waitFor(() => expect(models.Policy.update).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByLabelText("Status for policy HOA-2")).toHaveValue("EXPIRED"));
    await act(async () => first.resolve({ data: null, errors: [{ message: "First policy refused" }] }));
    expect(screen.getByRole("alert")).toHaveTextContent("First policy refused");
    expect(screen.getByLabelText("Status for policy HOA-1")).toHaveValue("ACTIVE");
    expect(screen.getByLabelText("Status for policy HOA-2")).toHaveValue("EXPIRED");
  });
});
