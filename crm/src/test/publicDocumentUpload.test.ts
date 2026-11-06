import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  lead: vi.fn(), portal: vi.fn(), create: vi.fn(), link: vi.fn(),
  leadUpdate: vi.fn(), portalUpdate: vi.fn(), reserve: vi.fn(), presign: vi.fn(),
}));
vi.mock("aws-amplify", () => ({ Amplify: { configure: vi.fn() } }));
vi.mock("@aws-amplify/backend/function/runtime", () => ({ getAmplifyDataClientConfig: async () => ({ resourceConfig: {}, libraryOptions: {} }) }));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models: {
  LeadReply: { listLeadReplyByUploadToken: h.lead, update: h.leadUpdate },
  UploadPortal: { listUploadPortalByToken: h.portal, update: h.portalUpdate },
  Document: { create: h.create, update: h.link },
} }) }));
vi.mock("@aws-sdk/client-s3", () => ({ S3Client: class {}, PutObjectCommand: class { constructor(public input: unknown) {} } }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: h.presign }));
vi.mock("../../amplify/functions/uploadQuota", () => ({ reserveUploadSlot: h.reserve }));
vi.mock("../../amplify/functions/monitoring", () => ({ captureHandledFailure: vi.fn() }));

import { handler as leadUpload } from "../../amplify/functions/lead-upload/handler";
import { handler as portalUpload } from "../../amplify/functions/upload-portal/handler";
import { MAX_FILES } from "../../../shared/leadUpload";
import { PORTAL_MAX_FILES } from "../../../shared/leadDocuments";

const token = "fictional-upload-token-for-tests";
const base = { filename: "_scan.pdf", sizeBytes: 1000, contentType: "application/pdf" };
const callers = [
  { name: "lead", invoke: (fields = {}) => leadUpload({ arguments: { uploadToken: token, ...base, ...fields } }), table: "lead-table", id: "reply", max: MAX_FILES },
  { name: "portal", invoke: (fields = {}) => portalUpload({ arguments: { token, documentKey: "policies", ...base, ...fields } }), table: "portal-table", id: "portal", max: PORTAL_MAX_FILES },
] as const;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("LEAD_REPLY_TABLE", "lead-table");
  vi.stubEnv("UPLOAD_PORTAL_TABLE", "portal-table");
  vi.stubEnv("DOCUMENTS_BUCKET", "fictional-docs");
  h.lead.mockResolvedValue({ data: [{ id: "reply", accountId: "a1", status: "WAITING" }] });
  h.portal.mockResolvedValue({ data: [{ id: "portal", accountId: "a1", expiresAt: new Date(Date.now() + 3600_000).toISOString(), uploadCount: 0 }] });
  h.create.mockResolvedValue({ data: { id: "d1" } });
  h.link.mockResolvedValue({}); h.leadUpdate.mockResolvedValue({}); h.portalUpdate.mockResolvedValue({});
  h.reserve.mockResolvedValue(1); h.presign.mockResolvedValue("https://files.example.test/signed");
});
afterEach(() => vi.unstubAllEnvs());

describe.each(callers)("$name public document upload", ({ name, invoke, table, id, max }) => {
  it("retains the initial filename for OCR while signing the normalized key and exact size", async () => {
    const result = await invoke();
    expect(result).toMatchObject({ ok: true, documentId: "d1", uploadCount: 1 });
    expect(h.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      entityType: "ACCOUNT", entityId: "a1", name: "_scan.pdf", uploadedName: "_scan.pdf", s3Key: "pending",
      contentType: "application/pdf", sizeBytes: 1000, ocrStatus: "PENDING", lastWriteBy: name === "lead" ? "lead-upload" : "upload-portal",
    }));
    expect(h.reserve).toHaveBeenCalledExactlyOnceWith({ tableName: table, id, max });
    expect(h.presign).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ input: {
      Bucket: "fictional-docs", Key: "documents/ACCOUNT/a1/d1/scan.pdf", ContentType: "application/pdf", ContentLength: 1000,
    } }), { expiresIn: 900 });
    expect(h.link).toHaveBeenCalledExactlyOnceWith({ id: "d1", s3Key: "documents/ACCOUNT/a1/d1/scan.pdf" });
    const update = name === "lead" ? h.leadUpdate : h.portalUpdate;
    expect(update).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id, lastUploadAt: expect.any(String) }));
    expect(update.mock.calls[0][0]).not.toHaveProperty("uploadCount");
    if (name === "lead") expect(update.mock.calls[0][0].dueAt).toBeDefined();
  });

  it.each([{ sizeBytes: 0 }, { sizeBytes: 1.5 }, { filename: "program.exe" }, { sizeBytes: 100 * 1024 * 1024 }])("rejects invalid files before reserving a slot (%j)", async fields => {
    expect(await invoke(fields)).toMatchObject({ ok: false });
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.presign).not.toHaveBeenCalled();
  });

  it("does not create or presign when the atomic quota is exhausted", async () => {
    h.reserve.mockResolvedValue(null);
    expect(await invoke()).toMatchObject({ ok: false });
    expect(h.create).not.toHaveBeenCalled(); expect(h.presign).not.toHaveBeenCalled();
  });

  it("does not create or reserve for an inactive or unknown token", async () => {
    h.lead.mockResolvedValue({ data: [{ id: "reply", status: "SENT" }] });
    h.portal.mockResolvedValue({ data: [{ id: "portal", expiresAt: "2020-01-01T00:00:00Z" }] });
    expect(await invoke()).toMatchObject({ ok: false });
    expect(h.reserve).not.toHaveBeenCalled(); expect(h.create).not.toHaveBeenCalled();
  });
});
