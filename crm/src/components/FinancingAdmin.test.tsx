import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }));
vi.mock("../lib/client", () => ({
  client: { models: { PfCounselOpinion: { list: h.list, create: h.create } } },
  friendlyError: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback,
}));
import { FinancingAdmin } from "./FinancingAdmin";

const opinion = (id: string, effectiveAt = "2020-01-01", reviewBy = "2099-01-01") => ({
  id, jurisdiction: "VA", effectiveAt, reviewBy, notes: `Opinion ${id}`, occurredAt: "2026-01-01T00:00:00Z",
});

beforeEach(() => {
  vi.clearAllMocks();
  h.list.mockResolvedValue({ data: [], nextToken: null });
  h.create.mockResolvedValue({ data: opinion("saved") });
});

describe("Financing administration", () => {
  it("keeps history for open and closed states and loads additional pages only on demand", async () => {
    h.list.mockImplementation(async ({ nextToken }) => nextToken
      ? { data: [{ ...opinion("current"), jurisdiction: "AK" }] }
      : { data: [{ ...opinion("old", "2000-01-01", "2001-01-01"), jurisdiction: "CA" }, opinion("future", "2100-01-01", "2102-01-01")], nextToken: "later" });
    render(<FinancingAdmin onChanged={vi.fn(async () => {})} />);
    const history = await screen.findByRole("table", { name: "Counsel opinion history" });
    expect(within(history).getByText("California")).toBeVisible();
    expect(within(history).getByText("Upcoming")).toBeVisible();
    expect(within(history).getByText("Past review")).toBeVisible();
    expect(h.list).toHaveBeenCalledExactlyOnceWith({ limit: 100, nextToken: undefined });
    expect(within(history).queryByText("Opinion current")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load more history" }));
    expect(await within(history).findByText("Opinion current")).toBeVisible();
    expect(within(history).getByText("Alaska")).toBeVisible();
    expect(within(history).getByText("Current")).toBeVisible();
    expect(within(history).getByText("Opinion old")).toBeVisible();
    expect(h.list).toHaveBeenLastCalledWith({ limit: 100, nextToken: "later" });
    expect(screen.queryByRole("button", { name: "Load more history" })).toBeNull();
    expect(screen.getByText("Regulatory reference").closest("details")).not.toHaveAttribute("open");
  });

  it("continues past empty pages without claiming history is empty", async () => {
    h.list.mockResolvedValueOnce({ data: [], nextToken: "later" }).mockResolvedValue({ data: [opinion("later")] });
    render(<FinancingAdmin onChanged={vi.fn(async () => {})} />);
    await screen.findByText("More opinion history is available.");
    expect(screen.queryByText("No opinions recorded.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load more history" }));
    expect(await screen.findByText("Opinion later")).toBeVisible();
  });

  it("keeps loaded history after a page error and retries the same cursor", async () => {
    h.list.mockResolvedValueOnce({ data: [opinion("first")], nextToken: "later" })
      .mockResolvedValueOnce({ data: [], errors: [{ message: "Next page unavailable" }] })
      .mockResolvedValue({ data: [opinion("last")] });
    render(<FinancingAdmin onChanged={vi.fn(async () => {})} />);
    await screen.findByText("Opinion first");
    fireEvent.click(screen.getByRole("button", { name: "Load more history" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Next page unavailable");
    expect(screen.getByText("Opinion first")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load more history" }));
    expect(await screen.findByText("Opinion last")).toBeVisible();
    expect(h.list.mock.calls.slice(1).map(([input]) => input.nextToken)).toEqual(["later", "later"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("rejects looping history cursors and allows a clean refresh", async () => {
    h.list.mockResolvedValueOnce({ data: [opinion("first")], nextToken: "later" })
      .mockResolvedValueOnce({ data: [opinion("loop")], nextToken: "later" })
      .mockResolvedValue({ data: [opinion("refreshed")] });
    render(<FinancingAdmin onChanged={vi.fn(async () => {})} />);
    await screen.findByText("Opinion first");
    fireEvent.click(screen.getByRole("button", { name: "Load more history" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't finish loading counsel opinions");
    expect(screen.queryByText("Opinion loop")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry history" }));
    expect(await screen.findByText("Opinion refreshed")).toBeVisible();
    expect(screen.queryByText("Opinion first")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows returned API errors instead of a false empty history and supports retry", async () => {
    h.list.mockResolvedValue({ data: [], errors: [{ message: "Opinion lookup failed" }] });
    render(<FinancingAdmin onChanged={vi.fn(async () => {})} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Opinion lookup failed");
    expect(screen.queryByText("No opinions recorded.")).toBeNull();
    h.list.mockResolvedValue({ data: [] });
    fireEvent.click(screen.getByRole("button", { name: "Retry history" }));
    expect(await screen.findByText("No opinions recorded.")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("records an opinion and waits for history and producer availability to refresh", async () => {
    let finishRefresh!: () => void;
    const onChanged = vi.fn(() => new Promise<void>(resolve => { finishRefresh = resolve; }));
    render(<FinancingAdmin onChanged={onChanged} />);
    await screen.findByText("No opinions recorded.");
    fireEvent.change(screen.getByLabelText("State"), { target: { value: "VA" } });
    fireEvent.change(screen.getByLabelText("Effective date"), { target: { value: "2026-09-30" } });
    expect(screen.getByLabelText("Review by")).toHaveValue("2028-09-30");
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "  Signed approval  " } });
    fireEvent.click(screen.getByRole("button", { name: "Record opinion" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({
      jurisdiction: "VA", effectiveAt: "2026-09-30", reviewBy: "2028-09-30", notes: "Signed approval",
    }));
    expect(h.list).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("Saving…");
    await act(async () => finishRefresh());
    expect(screen.getByRole("status")).toHaveTextContent("Opinion recorded.");
    expect(screen.getByLabelText("State")).toHaveValue("");
    expect(screen.getByLabelText("Notes")).toHaveValue("");
  });

  it("does not append a stale history page after a saved opinion refreshes the list", async () => {
    let finishPage!: (page: { data: ReturnType<typeof opinion>[] }) => void;
    h.list.mockResolvedValueOnce({ data: [opinion("first")], nextToken: "later" })
      .mockImplementationOnce(() => new Promise(resolve => { finishPage = resolve; }))
      .mockResolvedValue({ data: [opinion("fresh")] });
    render(<FinancingAdmin onChanged={vi.fn(async () => {})} />);
    await screen.findByText("Opinion first");
    fireEvent.click(screen.getByRole("button", { name: "Load more history" }));
    expect(screen.getByRole("button", { name: "Loading more history…" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("State"), { target: { value: "VA" } });
    fireEvent.change(screen.getByLabelText("Effective date"), { target: { value: "2026-09-30" } });
    fireEvent.click(screen.getByRole("button", { name: "Record opinion" }));
    await screen.findByText("Opinion recorded.");
    expect(screen.getByText("Opinion fresh")).toBeVisible();
    await act(async () => finishPage({ data: [opinion("stale")] }));
    expect(screen.queryByText("Opinion stale")).toBeNull();
    expect(screen.queryByRole("button", { name: "Load more history" })).toBeNull();
  });

  it("preserves the form and does not refresh after a rejected create", async () => {
    h.create.mockResolvedValue({ data: null, errors: [{ message: "Create rejected" }] });
    const onChanged = vi.fn(async () => {});
    render(<FinancingAdmin onChanged={onChanged} />);
    await screen.findByText("No opinions recorded.");
    fireEvent.change(screen.getByLabelText("State"), { target: { value: "OH" } });
    fireEvent.change(screen.getByLabelText("Effective date"), { target: { value: "2026-09-30" } });
    fireEvent.click(screen.getByRole("button", { name: "Record opinion" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Create rejected");
    expect(screen.getByLabelText("State")).toHaveValue("OH");
    expect(onChanged).not.toHaveBeenCalled();
    expect(h.list).toHaveBeenCalledOnce();
  });

  it("updates the generated review date as the effective date changes and preserves an explicit override", async () => {
    render(<FinancingAdmin onChanged={vi.fn(async () => {})} />);
    await screen.findByText("No opinions recorded.");
    const effective = screen.getByLabelText("Effective date");
    const review = screen.getByLabelText("Review by");
    fireEvent.change(effective, { target: { value: "2026-09-30" } });
    expect(review).toHaveValue("2028-09-30");
    fireEvent.change(effective, { target: { value: "2026-10-15" } });
    expect(review).toHaveValue("2028-10-15");
    fireEvent.change(effective, { target: { value: "" } });
    expect(review).toHaveValue("");
    fireEvent.change(effective, { target: { value: "2026-11-01" } });
    expect(review).toHaveValue("2028-11-01");
    fireEvent.change(review, { target: { value: "2027-06-30" } });
    fireEvent.change(effective, { target: { value: "2026-12-01" } });
    expect(review).toHaveValue("2027-06-30");
    fireEvent.change(screen.getByLabelText("State"), { target: { value: "VA" } });
    fireEvent.click(screen.getByRole("button", { name: "Record opinion" }));
    await waitFor(() => expect(h.create).toHaveBeenCalledWith(expect.objectContaining({
      effectiveAt: "2026-12-01", reviewBy: "2027-06-30",
    })));
    await screen.findByText("Opinion recorded.");
    fireEvent.change(effective, { target: { value: "2027-01-01" } });
    expect(review).toHaveValue("2029-01-01");
  });

});
