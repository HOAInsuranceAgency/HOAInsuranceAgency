import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import FileButton from "./FileButton";

const input = () => document.querySelector('input[type="file"]') as HTMLInputElement;
const pdf = (name: string) => new File(["x"], name, { type: "application/pdf" });

describe("FileButton", () => {
  it("hands the handler the selected files", async () => {
    const onFiles = vi.fn();
    render(<FileButton label="Add documents…" multiple onFiles={onFiles} />);
    await userEvent.setup().upload(input(), [pdf("policy.pdf"), pdf("budget.pdf")]);
    expect(onFiles.mock.calls[0][0]?.map((f: File) => f.name)).toEqual([
      "policy.pdf",
      "budget.pdf",
    ]);
  });

  /**
   * The selection must be a snapshot taken *before* the input is reset, not a
   * live FileList — browsers empty that list in place when `value` is cleared.
   * A handler deferring its read (a React state updater, an await) would then
   * stage nothing, which is how the create-lead page silently dropped every
   * batch of documents after the first.
   */
  it("materialises the selection before resetting the input", async () => {
    let readLate: File[] | null = null;
    const onFiles = vi.fn((files: File[] | null) => {
      // Whatever the handler got must survive the reset that already happened.
      expect(input().value).toBe("");
      readLate = files;
    });
    render(<FileButton label="Add documents…" multiple onFiles={onFiles} />);
    await userEvent.setup().upload(input(), [pdf("policy.pdf")]);
    expect(readLate).not.toBeNull();
    expect(readLate!.map((f) => f.name)).toEqual(["policy.pdf"]);
    expect(Array.isArray(readLate)).toBe(true);
  });

  it("re-selecting the same file fires the handler again", async () => {
    const onFiles = vi.fn();
    render(<FileButton label="Add documents…" onFiles={onFiles} />);
    const user = userEvent.setup();
    await user.upload(input(), pdf("policy.pdf"));
    await user.upload(input(), pdf("policy.pdf"));
    expect(onFiles).toHaveBeenCalledTimes(2);
  });

  it("disables the input while busy and says so", () => {
    render(<FileButton label="Add documents…" busy onFiles={vi.fn()} />);
    expect(input()).toBeDisabled();
    expect(screen.getByText("Uploading…")).toBeInTheDocument();
  });
});
