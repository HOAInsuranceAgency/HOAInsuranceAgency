import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, UserProfile } from "../lib/client";

const h = vi.hoisted(() => ({
  documents: vi.fn(), create: vi.fn(), children: vi.fn(), upload: vi.fn(),
  fill: vi.fn(), ai: vi.fn(), signature: vi.fn(), pages: vi.fn(),
}));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models: {} }) }));
vi.mock("../lib/client", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/client")>(),
  client: { models: {
    Document: { list: h.documents, create: h.create },
    Building: { list: h.children }, Contact: { list: h.children },
    PriorCarrier: { list: h.children }, Policy: { list: h.children },
    Quote: { list: h.children }, GlApplication: { list: h.children },
    GlClassCode: { list: h.children }, Blanket: { list: h.children }, Loss: { list: h.children },
  } },
}));
vi.mock("../lib/scopedStorage", () => ({ uploadData: h.upload }));
vi.mock("../lib/acord", async () => ({
  ...await import("../lib/acordRegistry"),
  MAPPED_APP_FORM_KEYS: (await import("../lib/acordApp")).MAPPED_APP_FORM_KEYS,
  fillAcordApp: h.fill, aiFillGaps: h.ai, signatureFor: h.signature, buildingPages: h.pages,
}));
vi.mock("./FilePreview", () => ({
  default: ({ name, s3Key }: { name: string; s3Key: string }) => <div role="dialog" aria-label={name}>{s3Key}</div>,
}));
import FormsTab from "./FormsTab";

const account = { id: "account", name: "Willow Court", stage: "LEAD" } as Account;
const profile = { id: "profile" } as UserProfile;
const document = { id: "doc", name: "acord125-Willow_Court.pdf", s3Key: "generated/account/form.pdf", createdAt: "2026-09-30T12:00:00Z" };

beforeEach(() => {
  vi.resetAllMocks();
  h.documents.mockResolvedValue({ data: [], nextToken: null });
  h.children.mockResolvedValue({ data: [], nextToken: null });
  h.create.mockResolvedValue({ data: document });
  h.signature.mockResolvedValue(undefined);
  h.pages.mockReturnValue([[]]);
  h.fill.mockResolvedValue({ pdf: {}, bytes: new Uint8Array([1]), empty: [], missing: [], unsigned: undefined });
  h.ai.mockResolvedValue({ bytes: new Uint8Array([1]), applied: [] });
  h.upload.mockReturnValue({ result: Promise.resolve() });
});

describe("carrier forms", () => {
  it("offers generation only for supported forms and keeps other forms in a closed disclosure", async () => {
    render(<FormsTab account={account} profile={profile} />);
    await screen.findByText("No generated forms yet");
    const carrierForms = screen.getByRole("region", { name: "Carrier forms" });
    const buttons = within(carrierForms).getAllByRole("button", { name: /^Generate ACORD/ });
    expect(buttons).toHaveLength(3);
    expect(buttons.map(button => button.getAttribute("aria-label"))).toEqual([
      "Generate ACORD 125 — Commercial Insurance Application",
      "Generate ACORD 126 — Commercial General Liability Section",
      "Generate ACORD 140 — Property Section",
    ]);
    const other = screen.getByText("Other forms");
    expect(other.closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("ACORD 131 — Umbrella / Excess Section")).not.toBeVisible();
    fireEvent.click(other);
    expect(screen.getByText("ACORD 131 — Umbrella / Excess Section")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Generate ACORD 131/ })).toBeNull();
    expect(screen.queryByText(/Mapping not built|field mapping/)).toBeNull();
  });

  it("waits for every history page before allowing generation", async () => {
    let finish!: (value: { data: typeof document[] }) => void;
    h.documents.mockResolvedValueOnce({ data: [document], nextToken: "page-2" })
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<FormsTab account={account} profile={profile} />);
    await waitFor(() => expect(h.documents).toHaveBeenCalledTimes(2));
    const buttons = screen.getAllByRole("button", { name: /^Generate ACORD/ });
    for (const button of buttons) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(h.fill).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    await act(async () => finish({ data: [] }));
    expect(screen.getByRole("table", { name: "Generated carrier forms" })).toBeVisible();
    for (const button of buttons) expect(button).toBeEnabled();
  });

  it.each([false, true])("blocks generation after a failed read and until retry succeeds (existing forms: %s)", async hasForms => {
    let finish!: (value: { data: typeof document[] }) => void;
    h.documents.mockResolvedValueOnce({ data: [], errors: [{ message: "History unavailable" }] })
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<FormsTab account={account} profile={profile} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("History unavailable");
    expect(screen.queryByText("No generated forms yet")).toBeNull();
    const buttons = screen.getAllByRole("button", { name: /^Generate ACORD/ });
    for (const button of buttons) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    fireEvent.click(screen.getByRole("button", { name: "Retry generated forms" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading generated forms…");
    expect(screen.queryByText("No generated forms yet")).toBeNull();
    for (const button of buttons) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(h.fill).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    await act(async () => finish({ data: hasForms ? [document] : [] }));
    for (const button of buttons) expect(button).toBeEnabled();
    if (hasForms) {
      expect(screen.getByRole("table", { name: "Generated carrier forms" })).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: `Preview ${document.name}` }));
      expect(screen.getByRole("dialog", { name: document.name })).toHaveTextContent(document.s3Key);
    } else {
      expect(screen.getByText("No generated forms yet")).toBeVisible();
    }
  });

  it("preserves generation progress, unsigned warnings, and AI review details", async () => {
    let finishUpload!: () => void;
    h.upload.mockReturnValue({ result: new Promise<void>(resolve => { finishUpload = resolve; }) });
    h.fill.mockResolvedValue({ pdf: {}, bytes: new Uint8Array([1]), empty: [], missing: [], unsigned: "no producer signature" });
    h.ai.mockResolvedValue({ bytes: new Uint8Array([1]), applied: [{ field: "insuredPhone", value: "555-0100", why: "Primary contact phone" }] });
    render(<FormsTab account={account} profile={profile} />);
    await screen.findByText("No generated forms yet");
    const generate = screen.getByRole("button", { name: "Generate ACORD 125 — Commercial Insurance Application" });
    fireEvent.click(generate);
    await waitFor(() => expect(h.upload).toHaveBeenCalledOnce());
    expect(generate).toHaveTextContent("Generating…");
    expect(screen.getAllByRole("button", { name: /^Generate ACORD/ }).every(button => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(h.fill.mock.calls[0][0]).toEqual(expect.objectContaining({ key: "acord125" }));
    expect(h.signature).toHaveBeenCalledWith("profile");
    await act(async () => finishUpload());
    expect(await screen.findByRole("status")).toHaveTextContent("UNSIGNED");
    expect(screen.getByRole("status")).toHaveTextContent("completed by AI");
    expect(screen.getByText("555-0100")).toBeVisible();
    expect(screen.getByText("Primary contact phone")).toBeVisible();
    expect(screen.getByRole("button", { name: `Preview ${document.name}` })).toBeVisible();
    expect(generate).toBeEnabled();
  });
});
