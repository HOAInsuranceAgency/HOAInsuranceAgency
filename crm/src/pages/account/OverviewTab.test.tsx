import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const accountUpdate = vi.hoisted(() => vi.fn());
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({ models: { Account: { update: accountUpdate } } }),
}));
import { OverviewTab } from "./OverviewTab";
import type { Account } from "../../lib/client";

const account = {
  id: "a1", name: "Harbor HOA", legalName: "Harbor Homeowners Association, Inc.",
  stage: "LEAD", type: "ASSOCIATION", leadSource: "GOOGLE_AD_WEBSITE", source: "website-quote",
} as Account;

beforeEach(() => {
  accountUpdate.mockReset().mockImplementation(async fields => ({ data: { ...account, ...fields } }));
});

describe("lead overview identity", () => {
  it("uses one name for the account and carrier submissions, preserving the existing legal name", async () => {
    const onChange = vi.fn();
    render(<OverviewTab account={account} onChange={onChange} />);
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(account.legalName);
    expect(screen.queryByText("Full legal name (carrier submissions)")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      name: account.legalName, legalName: account.legalName,
    })));

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "  Harbor Association LLC  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(accountUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
      id: account.id, name: "Harbor Association LLC", legalName: "Harbor Association LLC",
    })));
    const update = accountUpdate.mock.calls.at(-1)![0];
    expect(update).not.toHaveProperty("leadSource");
    expect(update).not.toHaveProperty("source");
  });

  it.each([null, "", "   "])("uses the existing account name when legal name is %j", legalName => {
    render(<OverviewTab account={{ ...account, legalName }} onChange={vi.fn()} />);
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(account.name);
  });

  it("rejects a blank merged name instead of diverging display and submission names", () => {
    render(<OverviewTab account={account} onChange={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByText("Enter a name.")).toBeInTheDocument();
    expect(accountUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["GOOGLE_AD_WEBSITE", "website-quote", "Google Ad Website · Quote form"],
    ["ORGANIC_WEBSITE", "website-contact", "Organic Website · Contact form"],
    ["PHONE", null, "Phone"],
    [null, null, "Not recorded"],
    [null, "website-quote", "Website · attribution not recorded · Quote form"],
  ])("combines recorded source and form for %s / %s", (leadSource, source, expected) => {
    render(<OverviewTab account={{ ...account, leadSource, source } as Account} onChange={vi.fn()} />);
    expect(screen.getByText(expected, { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("Website form", { selector: "label" })).not.toBeInTheDocument();
    expect(screen.queryByText("Set at creation. This value cannot be changed.")).not.toBeInTheDocument();
  });
});
