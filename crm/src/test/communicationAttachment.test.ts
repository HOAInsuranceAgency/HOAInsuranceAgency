import { beforeEach, afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ fetch: vi.fn(), create: vi.fn(), s3: vi.fn() }));
vi.mock("../../amplify/functions/communications/config", () => ({ credentials: async () => ({ frontToken: "secret" }) }));
vi.mock("../../amplify/functions/communications/providers", () => ({ permittedConversation: async () => ({ id: "cnv_a" }), messageConversation: () => "cnv_a", front: async () => ({ id: "msg_a", attachments: [{ id: "fil_a", filename: "test.pdf", content_type: "application/pdf", size: 100 }] }) }));
vi.mock("../../amplify/functions/communications/store", () => ({ get: async () => ({ data: { accountId: "a1" } }), hash: () => "document-id", row: vi.fn(), save: vi.fn() }));
vi.mock("../../amplify/functions/communications/data", () => ({ dataClient: async () => ({ models: { Document: { get: async () => ({ data: null }), create: h.create } } }) }));
vi.mock("@aws-sdk/client-s3", () => ({ S3Client: class { send = h.s3; }, HeadObjectCommand: class {}, PutObjectCommand: class {} }));
import { importAttachment } from "../../amplify/functions/communications/attachments";
beforeEach(() => { vi.clearAllMocks(); process.env.DOCUMENT_BUCKET = "test-bucket"; h.s3.mockRejectedValue({ $metadata: { httpStatusCode: 404 } }); vi.stubGlobal("fetch", h.fetch); });
afterEach(() => vi.unstubAllGlobals());
it("does not create an empty CRM document when Front redirects to an unsupported host", async () => {
  h.fetch.mockResolvedValue(new Response("", { status: 302, headers: { location: "https://untrusted.example/file" } }));
  await expect(importAttachment({ type: "ATTACHMENT", state: "READY", attempts: 0, accountId: "a1", sourceMessageId: "msg_a", attachmentId: "fil_a" })).rejects.toThrow("location needs review");
  expect(h.create).not.toHaveBeenCalled(); expect(h.fetch).toHaveBeenCalledTimes(1);
});
