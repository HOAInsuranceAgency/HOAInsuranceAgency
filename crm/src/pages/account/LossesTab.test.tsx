import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const Loss = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({ models: { Loss } }),
}));

import { LossesTab } from "./LossesTab";

/**
 * Loss history. The add/edit/delete machinery is `useChildRows`, covered by
 * `BuildingsCard.test.tsx`; what is asserted here is what this screen decides
 * for itself — the two required columns, the claim-date ordering rule, and the
 * three-state claim status.
 */

const rows = () => [
  {
    id: "l1",
    accountId: "a1",
    dateOfLoss: "2024-03-14",
    lineOfBusiness: "Property",
    typeOfLoss: "Water damage",
    amountPaid: 18400,
    amountReserved: 0,
    claimOpen: false,
    extractionSourceKey: "loss:2024-03-14|property|",
  },
  {
    id: "l2",
    accountId: "a1",
    dateOfLoss: "2026-01-09",
    lineOfBusiness: "General Liability",
    typeOfLoss: "Slip and fall",
    amountPaid: 5000,
    amountReserved: 25000,
    claimOpen: true,
    extractionSourceKey: "loss:2026-01-09|general liability|",
  },
  {
    id: "l3",
    accountId: "a1",
    dateOfLoss: "2025-07-02",
    lineOfBusiness: "Property",
    typeOfLoss: "Wind",
    amountPaid: null,
    amountReserved: null,
    claimOpen: null,
    extractionSourceKey: "loss:2025-07-02|property|",
  },
];

const renderTab = () => render(<LossesTab accountId="a1" />);
const toolbar = () => within(document.querySelector(".toolbar") as HTMLElement);
const editor = () => within(screen.getByRole("dialog"));

beforeEach(() => {
  Loss.list.mockReset();
  Loss.create.mockReset();
  Loss.update.mockReset();
  Loss.delete.mockReset();
  Loss.list.mockResolvedValue({ data: rows(), nextToken: null });
});

describe("the table", () => {
  it("puts the most recent loss first", async () => {
    renderTab();
    await screen.findByText("Slip and fall");

    const bodyRows = within(screen.getByRole("table")).getAllByRole("row");
    expect(bodyRows[1]).toHaveTextContent("1/9/2026");
    expect(bodyRows[2]).toHaveTextContent("7/2/2025");
    expect(bodyRows[3]).toHaveTextContent("3/14/2024");
  });

  it("distinguishes an open claim from a closed one from an unknown one", async () => {
    renderTab();
    await screen.findByText("Slip and fall");

    const table = within(screen.getByRole("table"));
    // The column is nullable on purpose: a claim nobody has told us the
    // status of is not a closed one.
    expect(table.getByText("Open")).toBeInTheDocument();
    expect(table.getByText("Closed")).toBeInTheDocument();
    expect(table.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("totals paid, reserved and open claims in the heading", async () => {
    renderTab();
    await screen.findByText("Slip and fall");

    // 18,400 + 5,000 paid; 25,000 reserved; one open.
    expect(screen.getByText(/\$23,400 paid/)).toBeInTheDocument();
    expect(screen.getByText(/\$25,000 reserved/)).toBeInTheDocument();
    expect(screen.getByText(/1 open/)).toBeInTheDocument();
  });

  it("asserts no totals at all while the read is in flight", async () => {
    // PATTERNS: never render an assertion about data you do not have yet. A
    // "$0 paid" over an unsettled read is a wrong answer, not a placeholder.
    Loss.list.mockReturnValue(new Promise<never>(() => {}));
    renderTab();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText(/paid/)).not.toBeInTheDocument();
  });
});

describe("validation", () => {
  it("requires a date of loss and a line of business", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Slip and fall");

    await user.click(screen.getByText("+ Add loss"));

    // Both are `.required()` on the model — a loss missing either cannot be
    // placed on the 125's rows, which are ordered by date and labelled by
    // line. Checking here turns a GraphQL variable error into a sentence.
    expect(await screen.findByText(/Date of loss is required\./)).toBeInTheDocument();
    expect(screen.getByText(/Line of business is required\./)).toBeInTheDocument();
    expect(Loss.create).not.toHaveBeenCalled();
  });

  it("rejects a claim reported before the loss happened", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Slip and fall");

    await user.click(screen.getAllByText("Edit")[0]);
    const dates = screen
      .getByRole("dialog")
      .querySelectorAll<HTMLInputElement>("input[type=date]");
    await user.clear(dates[0]);
    await user.type(dates[0], "2026-05-01");
    await user.type(dates[1], "2026-04-01");
    await user.click(screen.getByText("Save"));

    expect(
      await screen.findByText(/Date of loss can't be after the claim date\./)
    ).toBeInTheDocument();
    expect(Loss.update).not.toHaveBeenCalled();
  });
});

describe("add", () => {
  it("keys the row on date, line and amount", async () => {
    const user = userEvent.setup();
    Loss.create.mockResolvedValue({ data: rows()[0] });
    renderTab();
    await screen.findByText("Slip and fall");

    const date = document.querySelector<HTMLInputElement>(
      ".toolbar input[type=date]"
    )!;
    await user.type(date, "2026-02-01");
    await user.selectOptions(toolbar().getByRole("combobox"), "Flood");
    await user.click(screen.getByText("+ Add loss"));

    expect(Loss.create).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "a1",
        dateOfLoss: "2026-02-01",
        lineOfBusiness: "Flood",
        // Amount is part of the key and blank here, which is a key in its own
        // right — the same loss re-imported with no amount matches this row.
        extractionSourceKey: "loss:2026-02-01|flood|",
      })
    );
  });

  it("records an unanswered claim status as null, not as closed", async () => {
    const user = userEvent.setup();
    Loss.update.mockResolvedValue({ data: rows()[2] });
    renderTab();
    await screen.findByText("Wind");

    await user.click(screen.getAllByText("Edit")[1]);
    expect(editor().getByText("Claim open?")).toBeInTheDocument();
    await user.click(screen.getByText("Save"));

    expect(Loss.update).toHaveBeenCalledWith(
      expect.objectContaining({ claimOpen: null })
    );
  });
});
