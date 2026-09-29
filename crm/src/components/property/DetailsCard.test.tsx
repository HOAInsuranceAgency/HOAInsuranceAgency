import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const AccountModel = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models: { Account: AccountModel } }) }));
vi.mock("../../lib/googlePlaces", () => ({ AddressAutocomplete: () => null }));
import DetailsCard from "./DetailsCard";
import type { Account } from "../../lib/client";

const account = { id: "a", type: "ASSOCIATION", name: "Sample Condominium", unitCount: 24 } as Account;
beforeEach(() => {
  vi.clearAllMocks();
  AccountModel.update.mockImplementation(async (patch: Partial<Account>) => ({ data: { ...account, ...patch } }));
});
describe("editable property reporting group", () => {
  it("leaves an existing unclassified association unknown even when its name says condominium", () => {
    render(<DetailsCard account={account} onChange={vi.fn()} />);
    expect(screen.getByRole("combobox", { name: "Property type" })).toHaveValue("");
    expect(AccountModel.update).not.toHaveBeenCalled();
  });

  it("saves a classification or restores existing-information fallback without changing units", async () => {
    const onChange = vi.fn();
    render(<DetailsCard account={account} onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Property type" }), { target: { value: "CONDO" } });
    fireEvent.click(screen.getByRole("button", { name: "Save property" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: "a", propertyType: "CONDO", unitCount: 24 })));
    expect(AccountModel.update).toHaveBeenLastCalledWith(expect.objectContaining({ propertyType: "CONDO", unitCount: 24 }));
    fireEvent.change(screen.getByRole("combobox", { name: "Property type" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save property" }));
    await waitFor(() => expect(AccountModel.update).toHaveBeenLastCalledWith(expect.objectContaining({ propertyType: null, unitCount: 24 })));
  });

  it("persists and reopens an explicit Not recorded choice for a PERSONAL account", async () => {
    const personal = { ...account, type: "PERSONAL" } as Account;
    const onChange = vi.fn();
    const view = render(<DetailsCard account={personal} onChange={onChange} />);
    const select = screen.getByRole("combobox", { name: "Property type" });
    expect(select).toHaveValue("");
    expect(screen.getByRole("option", { name: "Use existing information" })).toBeVisible();
    fireEvent.change(select, { target: { value: "NOT_RECORDED" } });
    fireEvent.click(screen.getByRole("button", { name: "Save property" }));
    await waitFor(() => expect(AccountModel.update).toHaveBeenCalledWith(expect.objectContaining({ propertyType: "NOT_RECORDED" })));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    view.unmount();
    render(<DetailsCard account={{ ...personal, propertyType: "NOT_RECORDED" }} onChange={vi.fn()} />);
    expect(screen.getByRole("combobox", { name: "Property type" })).toHaveValue("NOT_RECORDED");
  });

  it("retains the selected classification after a failed save", async () => {
    AccountModel.update.mockResolvedValue({ data: null, errors: [{ message: "Storage unavailable" }] });
    const onChange = vi.fn();
    render(<DetailsCard account={account} onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Property type" }), { target: { value: "HOA_POA_POND_TOWNHOME" } });
    fireEvent.click(screen.getByRole("button", { name: "Save property" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Storage unavailable");
    expect(screen.getByRole("combobox", { name: "Property type" })).toHaveValue("HOA_POA_POND_TOWNHOME");
    expect(onChange).not.toHaveBeenCalled();
  });
});
