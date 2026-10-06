import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  models: {
    Certificate: { list: vi.fn(), create: vi.fn(), update: vi.fn() },
    Policy: { list: vi.fn() }, Carrier: { list: vi.fn() },
  },
  mutations: { reserveCertificateNumber: vi.fn() },
  fill: vi.fn(), signature: vi.fn(), ai: vi.fn(), upload: vi.fn(),
}));
vi.mock("aws-amplify/data", () => ({ generateClient: () => api }));
vi.mock("../../lib/acord", () => ({ fillAcord25: api.fill, signatureFor: api.signature, aiFillGaps: api.ai }));
vi.mock("../../lib/scopedStorage", () => ({ uploadData: api.upload }));
vi.mock("../../lib/storage", () => ({ downloadFile: vi.fn() }));
vi.mock("../../components/FilePreview", () => ({ default: () => null }));
import { CertificatesTab } from "./CertificatesTab";
import type { Account, UserProfile } from "../../lib/client";
const account = { id: "a1", stage: "CLIENT" } as Account;
const profile = { id: "u1", firstName: "Test", lastName: "Agent" } as UserProfile;
const cert = { id: "cert1", accountId: "a1", holderName: "Holder", certificateNumber: "C-1" };
beforeEach(() => {
  vi.resetAllMocks();
  api.models.Certificate.list.mockResolvedValue({ data: [] });
  api.models.Policy.list.mockResolvedValue({ data: [] });
  api.models.Carrier.list.mockResolvedValue({ data: [] });
  api.mutations.reserveCertificateNumber.mockResolvedValue({ data: { certificateNumber: "C-1" } });
  api.models.Certificate.create.mockResolvedValue({ data: cert });
  api.fill.mockResolvedValue({ bytes: new Uint8Array(), missing: [], unsigned: false, pdf: {}, empty: [] });
  api.ai.mockResolvedValue({ bytes: new Uint8Array(), applied: [] });
  api.upload.mockReturnValue({ result: Promise.resolve({}) });
  api.models.Certificate.update.mockResolvedValue({ data: { ...cert, s3Key: "certificates/a1/cert1.pdf" } });
});
async function form() {
  render(<CertificatesTab account={account} profile={profile} />);
  await screen.findByText("No certificates issued.");
  await userEvent.click(screen.getByRole("button", { name: "+ New certificate" }));
  await userEvent.type(screen.getAllByRole("textbox")[0], "Holder");
}
describe("certificate reliability", () => {
  it("keeps entries and enables retry after a resolved GraphQL create failure", async () => {
    api.models.Certificate.create.mockResolvedValueOnce({ data: null, errors: [{ message: "Certificate rejected" }] });
    await form();
    await userEvent.click(screen.getByRole("button", { name: "Record certificate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Certificate rejected");
    expect(screen.getAllByRole("textbox")[0]).toHaveValue("Holder");
    expect(api.fill).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Record certificate" }));
    expect(await screen.findByRole("button", { name: "Preview" })).toBeInTheDocument();
    expect(api.models.Certificate.create).toHaveBeenCalledTimes(2);
  });
  it("recovers from a rejected create and blocks duplicate submissions and edits while saving", async () => {
    let reject!: (e: Error) => void;
    api.models.Certificate.create.mockImplementationOnce(() => new Promise((_, bad) => { reject = bad; }));
    await form();
    const button = screen.getByRole("button", { name: "Record certificate" });
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    await waitFor(() => expect(api.models.Certificate.create).toHaveBeenCalledTimes(1));
    expect(screen.getAllByRole("textbox")[0]).toBeDisabled();
    await act(async () => reject(new Error("Network unavailable")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Network unavailable");
    expect(screen.getByRole("button", { name: "Record certificate" })).toBeEnabled();
    expect(screen.getAllByRole("textbox")[0]).toHaveValue("Holder");
  });
  it("blocks issuance until failed carrier pages can be retried successfully", async () => {
    api.models.Carrier.list.mockResolvedValueOnce({ data: [], errors: [{ message: "Carriers unavailable" }] });
    await form();
    expect(screen.getByRole("button", { name: "Record certificate" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Retry carriers" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Record certificate" })).toBeEnabled());
  });
  it("only runs one PDF generation across different certificate rows", async () => {
    api.models.Certificate.list.mockResolvedValue({ data: [cert, { ...cert, id: "cert2", holderName: "Other" }] });
    api.fill.mockImplementation(() => new Promise(() => {}));
    render(<CertificatesTab account={account} profile={profile} />);
    const buttons = await screen.findAllByRole("button", { name: "Generate PDF" });
    act(() => { fireEvent.click(buttons[0]); fireEvent.click(buttons[1]); });
    await waitFor(() => expect(api.fill).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Generate PDF" })).toBeDisabled();
  });
  it("clears the previous account's issuance draft when the account changes", async () => {
    const view = render(<CertificatesTab account={account} profile={profile} sourceCommunicationId="comm1" />);
    await userEvent.type(screen.getAllByRole("textbox")[0], "First account holder");
    view.rerender(<CertificatesTab account={{ ...account, id: "a2" }} profile={profile} sourceCommunicationId="comm2" />);
    expect(screen.getAllByRole("textbox")[0]).toHaveValue("");
  });
});
