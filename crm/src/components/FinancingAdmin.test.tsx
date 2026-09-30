import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }));
vi.mock("../lib/client", async () => ({
  client: { models: { PfCounselOpinion: { listPfCounselOpinionByJurisdictionAndEffectiveAt: h.list, create: h.create } } },
  friendlyError: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback,
  listAllPages: (await import("../lib/pagination")).listAllPages,
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
  it("loads complete indexed history and distinguishes upcoming and expired opinions", async () => {
    h.list.mockImplementation(async ({ jurisdiction }, { nextToken }) => jurisdiction !== "VA"
      ? { data: [] }
      : nextToken ? { data: [opinion("current")] }
        : { data: [opinion("old", "2000-01-01", "2001-01-01"), opinion("future", "2100-01-01", "2102-01-01")], nextToken: "later" });
    render(<FinancingAdmin onChanged={vi.fn(async () => {})} />);
    const history = await screen.findByRole("table", { name: "Counsel opinion history" });
    expect(within(history).getByText("Opinion current")).toBeVisible();
    expect(within(history).getByText("Current")).toBeVisible();
    expect(within(history).getByText("Upcoming")).toBeVisible();
    expect(within(history).getByText("Past review")).toBeVisible();
    expect(h.list).toHaveBeenCalledWith({ jurisdiction: "VA" }, { sortDirection: "DESC", limit: 100, nextToken: "later" });
    expect(new Set(h.list.mock.calls.map(([input]) => input.jurisdiction))).toEqual(new Set(["OH", "UT", "VA"]));
    expect(screen.getByText("Regulatory reference").closest("details")).not.toHaveAttribute("open");
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
    expect(h.list).toHaveBeenCalledTimes(6);
    expect(screen.getByRole("status")).toHaveTextContent("Saving…");
    await act(async () => finishRefresh());
    expect(screen.getByRole("status")).toHaveTextContent("Opinion recorded.");
    expect(screen.getByLabelText("State")).toHaveValue("");
    expect(screen.getByLabelText("Notes")).toHaveValue("");
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
    expect(h.list).toHaveBeenCalledTimes(3);
  });
});
