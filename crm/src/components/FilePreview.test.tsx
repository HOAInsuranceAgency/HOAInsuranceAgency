import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ getUrl: vi.fn() }));
vi.mock("../lib/scopedStorage", () => ({ getUrl: h.getUrl }));
vi.mock("../lib/client", () => ({ friendlyError: (e: Error) => e.message }));
import FilePreview from "./FilePreview";
beforeEach(() => { vi.resetAllMocks(); });
it("retries a failed signed URL without closing the preview", async () => {
  h.getUrl.mockRejectedValueOnce(new Error("Temporary file read error")).mockResolvedValueOnce({ url: new URL("https://example.com/a.pdf") });
  render(<FilePreview s3Key="a.pdf" name="a.pdf" onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry preview" }));
  await waitFor(() => expect(document.querySelector("iframe")).toHaveAttribute("src", "https://example.com/a.pdf"));
});
it("does not display or download the old file while a new file loads", async () => {
  h.getUrl.mockResolvedValueOnce({ url: new URL("https://example.com/a.pdf") });
  const view = render(<FilePreview s3Key="a.pdf" name="a.pdf" onClose={vi.fn()} />);
  await waitFor(() => expect(document.querySelector("iframe")).toHaveAttribute("src", "https://example.com/a.pdf"));
  let finish!: (value: unknown) => void;
  h.getUrl.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  view.rerender(<FilePreview s3Key="b.pdf" name="b.pdf" onClose={vi.fn()} />);
  expect(document.querySelector("iframe")).toBeNull();
  expect(screen.queryByRole("button", { name: "Open / download" })).toBeNull();
  await act(async () => finish({ url: new URL("https://example.com/b.pdf") }));
  expect(document.querySelector("iframe")).toHaveAttribute("src", "https://example.com/b.pdf");
});
