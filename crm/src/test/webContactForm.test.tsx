import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ContactForm } from "../../../web/src/components/ContactForm";

const submit = vi.hoisted(() => vi.fn());
vi.mock("../../../web/src/lib/crmLead", () => ({
  useLeadSubmission: () => ({ submit }),
}));

beforeEach(() => {
  submit.mockReset().mockResolvedValue({ accountId: "test-account", uploadToken: null });
});

it.each(["all", "form"] as const)("names every contact field in the %s layout and submits its values", async (part) => {
  render(<ContactForm part={part} />);
  const values = [
    ["First Name", "Alex"],
    ["Last Name", "Example"],
    ["Email address", "alex@example.test"],
    ["How can we help?", "Please contact our association."],
  ];
  for (const [name, value] of values) {
    const field = screen.getByRole("textbox", { name });
    fireEvent.change(field, { target: { value } });
    expect(field).toHaveAccessibleName(name);
  }
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  expect(await screen.findByRole("heading", { name: "Thank you!" })).toBeInTheDocument();
  expect(submit).toHaveBeenCalledTimes(1);
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({
    contactFirstName: "Alex",
    contactLastName: "Example",
    contactEmail: "alex@example.test",
    source: "website-contact",
    notes: "Please contact our association.",
  }));
});
