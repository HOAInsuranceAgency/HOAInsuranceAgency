import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Same stubbing as ExtractionPanel.test.tsx: replace generateClient rather
// than ./client, so the actor proxy that stamps `lastWriteBy` stays real.
const models = vi.hoisted(() => ({
  Document: { observeQuery: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({ models, mutations: {} }),
}));
vi.mock("aws-amplify/auth", () => ({
  getCurrentUser: vi.fn(async () => ({ userId: "u1" })),
}));
vi.mock("aws-amplify/storage", () => ({
  uploadData: vi.fn(),
  getUrl: vi.fn(),
  remove: vi.fn(),
}));

import DocumentsPanel from "./DocumentsPanel";

/**
 * Renaming a document.
 *
 * The CRM is behind Cognito magic-link auth, so this panel cannot be driven
 * in a browser without a real sign-in. This is the substitute.
 *
 * What it is here to hold: the extension survives whatever the producer
 * types. `FilePreview.canPreview` reads the file type off `name`, so a
 * rename that drops ".pdf" takes the Preview button with it — and the row
 * would still look perfectly fine.
 */

const DOC = {
  id: "doc-1",
  name: "scan_0043.pdf",
  s3Key: "documents/ACCOUNT/acct-1/doc-1/scan_0043.pdf",
  category: "BUDGET",
  ocrStatus: "COMPLETE",
  sizeBytes: 120_000,
  createdAt: "2026-08-01T10:00:00.000Z",
};

/** The `update` call that carried a `name`, if any. */
const renameCall = () =>
  models.Document.update.mock.calls.find(([arg]) => "name" in arg)?.[0];

function renderPanel(doc: Record<string, unknown> = DOC) {
  models.Document.observeQuery.mockReturnValue({
    subscribe: ({ next }: { next: (v: { items: unknown[] }) => void }) => {
      next({ items: [doc] });
      return { unsubscribe: vi.fn() };
    },
  });
  render(<DocumentsPanel entityType="ACCOUNT" entityId="acct-1" />);
}

/** Click Rename, replace the box's contents with `text`. */
async function typeName(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(screen.getByRole("button", { name: "Rename" }));
  const box = screen.getByRole("textbox", { name: "Document name" });
  await user.clear(box);
  if (text) await user.type(box, text);
  return box;
}

beforeEach(() => {
  vi.clearAllMocks();
  models.Document.update.mockResolvedValue({ errors: undefined });
});

describe("DocumentsPanel rename", () => {
  it("saves the typed name with the file's extension restored", async () => {
    const user = userEvent.setup();
    renderPanel();

    // No extension typed — the producer should not have to remember one.
    await typeName(user, "2024 Operating Budget");
    await user.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() =>
      expect(renameCall()).toEqual({
        id: "doc-1",
        name: "2024 Operating Budget.pdf",
        lastWriteBy: "u1",
      })
    );
  });

  it("takes the extension from the stored object, not the name being replaced", async () => {
    const user = userEvent.setup();
    // A row already renamed once, to something with no extension at all.
    renderPanel({ ...DOC, name: "Budget" });

    await typeName(user, "2024 Operating Budget");
    await user.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() =>
      expect(renameCall()?.name).toBe("2024 Operating Budget.pdf")
    );
  });

  it("saves on Enter", async () => {
    const user = userEvent.setup();
    renderPanel();

    await typeName(user, "Loss Runs 2021-2024{Enter}");

    await waitFor(() => expect(renameCall()?.name).toBe("Loss Runs 2021-2024.pdf"));
  });

  it("writes nothing on Escape", async () => {
    const user = userEvent.setup();
    renderPanel();

    await typeName(user, "Half-typed thought{Escape}");

    expect(models.Document.update).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Rename" })).toBeTruthy();
  });

  it("writes nothing on Cancel", async () => {
    const user = userEvent.setup();
    renderPanel();

    await typeName(user, "Half-typed thought");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(models.Document.update).not.toHaveBeenCalled();
  });

  it("refuses an empty name instead of writing a blank cell", async () => {
    const user = userEvent.setup();
    renderPanel();

    await typeName(user, "");
    await user.click(screen.getByRole("button", { name: "Save name" }));

    expect(models.Document.update).not.toHaveBeenCalled();
    // Still editing, with the reason on screen — not silently dismissed.
    expect(screen.getByRole("alert").textContent).toMatch(/needs a name/i);
    expect(screen.getByRole("textbox", { name: "Document name" })).toBeTruthy();
  });

  it("skips the write when the name is unchanged", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.click(screen.getByRole("button", { name: "Save name" }));

    expect(models.Document.update).not.toHaveBeenCalled();
  });

  it("reports a failed rename", async () => {
    const user = userEvent.setup();
    renderPanel();
    models.Document.update.mockResolvedValue({
      errors: [{ message: "Not authorized" }],
    });

    await typeName(user, "2024 Operating Budget");
    await user.click(screen.getByRole("button", { name: "Save name" }));

    // `errors` on an Amplify write does not throw; dropping it would leave
    // the row reading as renamed until the next subscription push. The copy
    // is `friendlyError`'s, not the raw "Not authorized" from AppSync.
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/permission/i)
    );
  });

  it("hides the row's other actions while it is being renamed", async () => {
    const user = userEvent.setup();
    renderPanel();

    const row = screen.getByRole("row", { name: /scan_0043/ });
    expect(within(row).getByRole("button", { name: "Download" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Rename" }));

    // A Download click mid-edit would discard the typing without saying so.
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  });
});
