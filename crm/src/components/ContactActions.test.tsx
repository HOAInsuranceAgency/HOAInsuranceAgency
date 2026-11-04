import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import ContactActions from "./ContactActions";
import { emailAction, phoneActions } from "../lib/contactActions";

afterEach(() => vi.restoreAllMocks());

describe("contact destinations", () => {
  it.each(["(617) 555-0123", "617.555.0123", "1-617-555-0123", "+1 (617) 555-0123"])("opens the intended US number for %s", raw => {
    expect(phoneActions(raw)).toEqual({ tel: "tel:+16175550123", dialpad: "https://dialpad.com/launch?phone=%2B16175550123" });
  });
  it("preserves an explicit international country code", () => {
    expect(phoneActions("+44 20 7946 0123")?.tel).toBe("tel:+442079460123");
  });
  it.each(["617-555-0123 x42", "617-555-0123 ext. 42", "617-555-0123 extension 42", "617-555-0123 #42"])("retains extensions without inventing a Dialpad extension URL: %s", raw => {
    expect(phoneActions(raw)).toEqual({ tel: "tel:+16175550123;ext=42", dialpad: null });
  });
  it.each([null, "", "555-0123", "Call 6175550123", "+16175550123?autocall=1", "++16175550123", "+01234567890", "6175550123;ext=42", "6175550123\n<script>"])("keeps ambiguous or malformed numbers as selectable text: %s", raw => {
    expect(phoneActions(raw)).toBeNull();
  });
  it("encodes the mailbox as one recipient, preserving plus addressing", () => {
    expect(emailAction(" jake+testing@example.com ")).toBe("mailto:jake%2Btesting@example.com");
    expect(emailAction("name?subject=oops@example.com")).toBe("mailto:name%3Fsubject%3Doops@example.com");
    expect(emailAction("jake@example.com\r\nbcc:other@example.com")).toBeNull();
    expect(emailAction("not an email")).toBeNull();
  });
});

it("offers accessible call, Dialpad and copy actions without starting a call itself", async () => {
  const user = userEvent.setup();
  const parent = vi.fn();
  render(<div onClick={parent}><ContactActions kind="phone" value="(617) 555-0123" contactName="Pat" /></div>);
  expect(screen.getByRole("link", { name: "Call Pat" })).toHaveAttribute("href", "tel:+16175550123");
  const dialpad = screen.getByRole("link", { name: "Open Pat's number in Dialpad" });
  expect(dialpad).toHaveAttribute("rel", "noopener noreferrer");
  expect(dialpad).toHaveAttribute("referrerpolicy", "no-referrer");
  await user.click(screen.getByRole("button", { name: "Copy Pat's phone number" }));
  expect(await navigator.clipboard.readText()).toBe("(617) 555-0123");
  expect(screen.getByRole("status")).toHaveTextContent("Copied");
  expect(parent).not.toHaveBeenCalled();
});

it("keeps invalid data available for copying without making a broken link", () => {
  render(<ContactActions kind="phone" value="Ask the manager" contactName="Pat" />);
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  expect(screen.getByText("Ask the manager")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Copy Pat's phone number" })).toBeInTheDocument();
});

it("provides an honest selectable-text fallback when clipboard access fails", async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Blocked"));
  render(<ContactActions kind="email" value="pat@example.com" contactName="Pat" />);
  expect(screen.getByRole("link", { name: "Email Pat" })).toHaveAttribute("href", "mailto:pat@example.com");
  await user.click(screen.getByRole("button", { name: "Copy Pat's email address" }));
  expect(screen.getByRole("status")).toHaveTextContent("Select and copy the text");
});

it("does not update after an in-flight clipboard write outlives the contact", async () => {
  let finish!: () => void;
  userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  const view = render(<ContactActions kind="email" value="pat@example.com" contactName="Pat" />);
  fireEvent.click(screen.getByRole("button", { name: "Copy Pat's email address" }));
  view.unmount();
  await act(async () => finish());
});
