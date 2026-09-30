import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "../../lib/client";

const h = vi.hoisted(() => ({ update: vi.fn(), upload: vi.fn(), getUrl: vi.fn(), remove: vi.fn() }));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models: { Account: { update: h.update } } }) }));
vi.mock("aws-amplify/auth", () => ({ getCurrentUser: async () => ({ userId: "actor" }) }));
vi.mock("../../lib/scopedStorage", () => ({ uploadData: h.upload, getUrl: h.getUrl, remove: h.remove }));
vi.mock("../FilePreview", () => ({ default: ({ name, s3Key, onClose }: { name: string; s3Key: string; onClose: () => void }) => <div role="dialog" aria-label={name}>{s3Key}<button onClick={onClose}>Close</button></div> }));
import PhotosCard from "./PhotosCard";

const account = { id: "a", name: "Sample", coverPhotoKey: "property-photos/a/coverPhotoKey-old.jpg" } as Account;
beforeEach(() => {
  vi.clearAllMocks();
  h.update.mockImplementation(async (patch: Partial<Account>) => ({ data: { ...account, ...patch } }));
  h.upload.mockReturnValue({ result: Promise.resolve() });
  h.getUrl.mockResolvedValue({ url: new URL("https://example.test/old.jpg") });
  h.remove.mockResolvedValue({});
});

describe("site photos and plans", () => {
  it("provides labeled uploads, clear empty states, and keyboard preview controls", async () => {
    const user = userEvent.setup();
    render(<PhotosCard account={account} onChange={vi.fn()} />);
    expect(screen.getByText("No aerial photo")).toBeVisible();
    expect(screen.getByText("No plot plan")).toBeVisible();
    expect(screen.getByLabelText("Upload aerial photo")).toHaveAttribute("type", "file");
    expect(screen.getByLabelText("Replace cover photo")).toHaveAttribute("accept", "image/*,.pdf");
    const preview = screen.getByRole("button", { name: "Preview cover photo" });
    preview.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog")).toHaveTextContent(account.coverPhotoKey!);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(["GraphQL error", "lost response"])("retains both same-name files after an account update %s", async failure => {
    if (failure === "GraphQL error") {
      h.update.mockResolvedValue({ data: null, errors: [{ message: "Photo save unavailable" }] });
    } else {
      h.update.mockRejectedValue(new Error("Photo save unavailable"));
    }
    const onChange = vi.fn();
    render(<PhotosCard account={account} onChange={onChange} />);
    const upload = screen.getByLabelText("Replace cover photo");
    fireEvent.change(upload, { target: { files: [new File(["image"], "old.jpg", { type: "image/jpeg" })] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Photo save unavailable");
    expect(h.upload).toHaveBeenCalledOnce();
    const newPath = h.upload.mock.calls[0][0].path;
    expect(newPath).toMatch(/^property-photos\/a\/coverPhotoKey-[0-9a-f-]+-old\.jpg$/);
    expect(newPath).not.toBe(account.coverPhotoKey);
    expect(h.update).toHaveBeenCalledWith(expect.objectContaining({ id: account.id, coverPhotoKey: newPath }));
    // The lost response may follow a committed update; neither object is safe
    // to delete until the actual account state is known.
    expect(h.remove).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(upload).toBeEnabled();
  });

  it("removes the prior file only after the replacement is recorded", async () => {
    let finish!: (result: { data: Account }) => void;
    h.update.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const onChange = vi.fn();
    render(<PhotosCard account={account} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Replace cover photo"), { target: { files: [new File(["image"], "new.jpg", { type: "image/jpeg" })] } });
    await waitFor(() => expect(h.update).toHaveBeenCalledOnce());
    expect(h.remove).not.toHaveBeenCalled();
    const updated = { ...account, coverPhotoKey: h.update.mock.calls[0][0].coverPhotoKey };
    await act(async () => finish({ data: updated }));
    expect(h.remove).toHaveBeenCalledWith({ path: account.coverPhotoKey });
    expect(onChange).toHaveBeenCalledWith(updated);
  });

  it("keeps removal confirmation and preserves the file when clearing the account fails", async () => {
    h.update.mockResolvedValueOnce({ data: null, errors: [{ message: "Removal unavailable" }] });
    const onChange = vi.fn();
    render(<PhotosCard account={account} onChange={onChange} />);
    const cover = within(screen.getByRole("article", { name: "Cover photo" }));
    fireEvent.click(cover.getByRole("button", { name: "Remove" }));
    expect(h.update).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
    fireEvent.click(cover.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Removal unavailable");
    expect(h.remove).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(cover.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ coverPhotoKey: null })));
    expect(h.remove).toHaveBeenCalledWith({ path: account.coverPhotoKey });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a recoverable preview control when a thumbnail request fails", async () => {
    h.getUrl.mockRejectedValue(new Error("URL unavailable"));
    render(<PhotosCard account={account} onChange={vi.fn()} />);
    expect(await screen.findByText("Preview unavailable")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Preview cover photo" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(account.coverPhotoKey!);
  });

  it.each(["resolve", "reject"])("ignores a stale thumbnail %s after the file changes", async outcome => {
    let finishOld!: (result: { url: URL }) => void;
    let rejectOld!: (error: Error) => void;
    h.getUrl.mockImplementationOnce(() => new Promise((resolve, reject) => { finishOld = resolve; rejectOld = reject; }))
      .mockResolvedValueOnce({ url: new URL("https://example.test/new.jpg") });
    const view = render(<PhotosCard account={account} onChange={vi.fn()} />);
    view.rerender(<PhotosCard account={{ ...account, coverPhotoKey: "property-photos/a/coverPhotoKey-new.jpg" }} onChange={vi.fn()} />);
    const preview = screen.getByRole("button", { name: "Preview cover photo" });
    await waitFor(() => expect(preview.querySelector("img")).toHaveAttribute("src", "https://example.test/new.jpg"));
    await act(async () => {
      if (outcome === "resolve") finishOld({ url: new URL("https://example.test/old.jpg") });
      else rejectOld(new Error("Expired old thumbnail"));
    });
    expect(preview.querySelector("img")).toHaveAttribute("src", "https://example.test/new.jpg");
    expect(screen.queryByText("Preview unavailable")).not.toBeInTheDocument();
  });

  it("blocks other uploads and an armed removal while a photo upload is pending", async () => {
    let finishUpload!: () => void;
    h.upload.mockReturnValue({ result: new Promise<void>(resolve => { finishUpload = resolve; }) });
    render(<PhotosCard account={account} onChange={vi.fn()} />);
    const cover = within(screen.getByRole("article", { name: "Cover photo" }));
    fireEvent.click(cover.getByRole("button", { name: "Remove" }));
    fireEvent.change(screen.getByLabelText("Upload aerial photo"), { target: { files: [new File(["aerial"], "aerial.jpg", { type: "image/jpeg" })] } });
    expect(cover.getByRole("button", { name: "Confirm" })).toBeDisabled();
    expect(screen.getByLabelText("Replace cover photo")).toBeDisabled();
    expect(screen.getByLabelText("Upload plot plan")).toBeDisabled();
    // Even a second input event already queued before render cannot overlap.
    fireEvent.change(screen.getByLabelText("Upload plot plan"), { target: { files: [new File(["plan"], "plan.pdf", { type: "application/pdf" })] } });
    expect(h.upload).toHaveBeenCalledOnce();
    expect(h.update).not.toHaveBeenCalled();
    await act(async () => finishUpload());
    expect(h.update).toHaveBeenCalledOnce();
    expect(h.remove).not.toHaveBeenCalled();
    expect(cover.getByRole("button", { name: "Confirm" })).toBeEnabled();
    expect(screen.getByLabelText("Upload plot plan")).toBeEnabled();
  });

  it("disables all upload controls until a confirmed removal is saved", async () => {
    let finishRemoval!: (result: { data: Account }) => void;
    h.update.mockImplementation(() => new Promise(resolve => { finishRemoval = resolve; }));
    render(<PhotosCard account={account} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(screen.getByLabelText("Replace cover photo")).toBeDisabled();
    expect(screen.getByLabelText("Upload aerial photo")).toBeDisabled();
    expect(h.remove).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Upload aerial photo"), { target: { files: [new File(["aerial"], "aerial.jpg", { type: "image/jpeg" })] } });
    expect(h.upload).not.toHaveBeenCalled();
    await waitFor(() => expect(h.update).toHaveBeenCalledOnce());
    await act(async () => finishRemoval({ data: { ...account, coverPhotoKey: null } }));
    expect(h.remove).toHaveBeenCalledExactlyOnceWith({ path: account.coverPhotoKey });
    expect(screen.getByLabelText("Upload aerial photo")).toBeEnabled();
  });
});
