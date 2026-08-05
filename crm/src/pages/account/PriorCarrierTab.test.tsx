import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const PriorCarrier = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({ models: { PriorCarrier } }),
}));

import { PriorCarrierTab } from "./PriorCarrierTab";

/**
 * The prior-coverage table. The read/add/edit/delete machinery is
 * `useChildRows`, covered by `BuildingsCard.test.tsx`; what is tested here is
 * what this screen adds on top of it.
 */

const rows = () => [
  {
    id: "p1",
    accountId: "a1",
    lineOfBusiness: "General Liability",
    carrierName: "Travelers",
    policyNumber: "GL-1001",
    premium: 18400,
    effectiveDate: "2025-06-01",
    expirationDate: "2026-06-01",
    extractionSourceKey: "travelers|gl-1001|general liability",
  },
  {
    id: "p2",
    accountId: "a1",
    lineOfBusiness: "Property",
    carrierName: "Acme Mutual",
    policyNumber: "CP-77",
    premium: 42000,
    effectiveDate: "2024-03-01",
    expirationDate: "2025-03-01",
    extractionSourceKey: "acme mutual|cp-77|property",
  },
];

const renderTab = () => render(<PriorCarrierTab accountId="a1" />);
const toolbar = () => within(document.querySelector(".toolbar") as HTMLElement);

beforeEach(() => {
  PriorCarrier.list.mockReset();
  PriorCarrier.create.mockReset();
  PriorCarrier.update.mockReset();
  PriorCarrier.delete.mockReset();
  PriorCarrier.list.mockResolvedValue({ data: rows(), nextToken: null });
});

describe("the table", () => {
  it("puts the most recent term first", async () => {
    renderTab();
    await screen.findByText("Travelers");

    // The expiring policy is what a renewal submission is about; the older
    // rows are history.
    const bodyRows = within(screen.getByRole("table")).getAllByRole("row");
    expect(bodyRows[1]).toHaveTextContent("Travelers");
    expect(bodyRows[2]).toHaveTextContent("Acme Mutual");
  });

  it("renders money and dates formatted, not raw", async () => {
    renderTab();
    await screen.findByText("Travelers");

    const table = within(screen.getByRole("table"));
    expect(table.getByText("$18,400")).toBeInTheDocument();
    expect(table.getByText("6/1/2026")).toBeInTheDocument();
  });
});

describe("add", () => {
  it("keys the row on carrier, policy number and line together", async () => {
    const user = userEvent.setup();
    PriorCarrier.create.mockResolvedValue({ data: rows()[0] });
    renderTab();
    await screen.findByText("Travelers");

    await user.selectOptions(toolbar().getByRole("combobox"), "D&O");
    await user.type(toolbar().getByPlaceholderText("Travelers"), "Hanover");
    await user.type(toolbar().getAllByRole("textbox")[1], "DO-9");
    await user.click(screen.getByText("+ Add prior carrier"));

    expect(PriorCarrier.create).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "a1",
        lineOfBusiness: "D&O",
        carrierName: "Hanover",
        policyNumber: "DO-9",
        // All three: policy numbers are only unique within a carrier, and a
        // package policy covering two lines needs to be two rows.
        extractionSourceKey: "hanover|do-9|d&o",
      })
    );
  });

  it("rejects a term that ends before it starts, before writing", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Travelers");

    const dates = document.querySelectorAll<HTMLInputElement>(
      ".toolbar input[type=date]"
    );
    await user.type(dates[0], "2026-06-01");
    await user.type(dates[1], "2025-06-01");
    await user.click(screen.getByText("+ Add prior carrier"));

    expect(
      await screen.findByText(/Effective date can't be after the expiration date\./)
    ).toBeInTheDocument();
    expect(PriorCarrier.create).not.toHaveBeenCalled();
  });
});

describe("edit", () => {
  it("recomputes the key when the policy number is corrected", async () => {
    const user = userEvent.setup();
    PriorCarrier.update.mockResolvedValue({
      data: { ...rows()[0], policyNumber: "GL-1002" },
    });
    renderTab();
    await screen.findByText("Travelers");

    await user.click(screen.getAllByText("Edit")[0]);
    const number = screen.getByDisplayValue("GL-1001");
    await user.clear(number);
    await user.type(number, "GL-1002");
    await user.click(screen.getByText("Save"));

    expect(PriorCarrier.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "p1",
        policyNumber: "GL-1002",
        extractionSourceKey: "travelers|gl-1002|general liability",
      })
    );
  });
});
