import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import NumberField from "../../../web/src/components/quote/NumberField";
import { buildCrmLead } from "../../../web/src/components/quote/submission";
import { validateText } from "../../../web/src/components/quote/schema";

afterEach(cleanup);

function Field({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <>
    <NumberField aria-label="Replacement cost" value={value} onChange={setValue} />
    <output data-testid="submitted">{buildCrmLead({ role: "board", replacementValue: value }, "Brian").replacementValue ?? ""}</output>
  </>;
}

it("adds commas while typing and submits the full unformatted amount", async () => {
  const user = userEvent.setup();
  render(<Field />);
  await user.type(screen.getByRole("textbox"), "5000000");
  expect(screen.getByRole("textbox")).toHaveValue("5,000,000");
  expect(screen.getByTestId("submitted")).toHaveTextContent(/^5000000$/);
  expect(validateText(screen.getByTestId("submitted").textContent!, "replacement", true)).toBeNull();
});

it("accepts pasted grouping, preserves cents, and clears optional values", async () => {
  const user = userEvent.setup();
  render(<Field />);
  await user.click(screen.getByRole("textbox"));
  await user.paste("1,250,000.50");
  expect(screen.getByRole("textbox")).toHaveValue("1,250,000.50");
  expect(screen.getByTestId("submitted")).toHaveTextContent(/^1250000\.50$/);
  await user.clear(screen.getByRole("textbox"));
  expect(screen.getByRole("textbox")).toHaveValue("");
  expect(screen.getByTestId("submitted")).toBeEmptyDOMElement();
});

it("keeps the caret beside a middle edit instead of moving it to the end", () => {
  render(<Field initial="12345" />);
  const field = screen.getByRole("textbox") as HTMLInputElement;
  fireEvent.change(field, { target: { value: "192,345", selectionStart: 2 } });
  expect(field).toHaveValue("192,345");
  expect(field.selectionStart).toBe(2);
  expect(screen.getByTestId("submitted")).toHaveTextContent(/^192345$/);
});

it("preserves a trailing decimal and rejects invalid pasted text without changing the amount", async () => {
  const user = userEvent.setup();
  render(<Field initial="25000" />);
  const field = screen.getByRole("textbox");
  await user.type(field, ".00");
  expect(field).toHaveValue("25,000.00");
  fireEvent.change(field, { target: { value: "25,000 dollars" } });
  expect(field).toHaveValue("25,000.00");
  expect(screen.getByTestId("submitted")).toHaveTextContent(/^25000\.00$/);
});
