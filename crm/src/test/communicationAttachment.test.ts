import { beforeEach, afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ fetch: vi.fn(), create: vi.fn(), existing: vi.fn(), s3: vi.fn(), front: vi.fn() }));
vi.mock("../../amplify/functions/communications/config", () => ({ credentials: async () => ({ frontToken: "secret" }) }));
vi.mock("../../amplify/functions/communications/providers", () => ({ permittedConversation: async () => ({ id: "cnv_a" }), messageConversation: () => "cnv_a", front: h.front }));
vi.mock("../../amplify/functions/communications/store", () => ({ get: async () => ({ data: { accountId: "a1" } }), hash: () => "document-id", row: vi.fn(), save: vi.fn() }));
vi.mock("../../amplify/functions/communications/data", () => ({ dataClient: async () => ({ models: { Document: { get: h.existing, create: h.create } } }) }));
vi.mock("@aws-sdk/client-s3", () => ({ S3Client: class { send = h.s3; }, HeadObjectCommand: class { constructor(public input: unknown) {} }, PutObjectCommand: class { constructor(public input: unknown) {} } }));
import { importAttachment } from "../../amplify/functions/communications/attachments";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
const op = { type: "ATTACHMENT" as const, state: "READY" as const, attempts: 0, accountId: "a1", sourceMessageId: "msg_a", attachmentId: "fil_a", requestedBy: "user-1" };
const message = (filename = "test.pdf") => ({ id: "msg_a", attachments: [{ id: "fil_a", filename, content_type: "application/pdf", size: 100 }] });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("DOCUMENT_BUCKET", "test-bucket"); vi.stubGlobal("fetch", h.fetch);
  h.front.mockResolvedValue(message()); h.existing.mockResolvedValue({ data: null }); h.create.mockResolvedValue({ data: { id: "front-document-id" } });
  h.s3.mockImplementation(async command => { if (command instanceof HeadObjectCommand) throw { $metadata: { httpStatusCode: 404 } }; return {}; });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("does not create an empty CRM document when Front redirects to an unsupported host", async () => {
  h.fetch.mockResolvedValue(new Response("", { status: 302, headers: { location: "https://untrusted.example/file" } }));
  await expect(importAttachment(op)).rejects.toThrow("location needs review");
  expect(h.create).not.toHaveBeenCalled(); expect(h.fetch).toHaveBeenCalledTimes(1);
});

it("stamps the existing Front display name and preserves its deterministic ID and exact legacy key", async () => {
  h.front.mockResolvedValue(message(" _scan../budget.pdf"));
  h.fetch.mockResolvedValue(new Response("pdf bytes", { headers: { "content-type": "application/pdf" } }));
  expect(await importAttachment(op)).toBe("front-document-id");
  const key = "documents/ACCOUNT/a1/front-document-id/ _scan.._budget.pdf";
  expect(h.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    id: "front-document-id", name: " _scan.._budget.pdf", uploadedName: " _scan.._budget.pdf", s3Key: key,
    uploadedBy: "user-1", sizeBytes: 9, lastWriteBy: "front-attachment",
  }));
  expect(h.s3.mock.calls.map(([command]) => command.input.Key)).toEqual([key, key]);

  // A retry after both row and object exist neither downloads nor restamps a
  // producer's rename (or a legacy row without uploadedName).
  h.existing.mockResolvedValue({ data: { id: "front-document-id", name: "Reviewed budget.pdf" } });
  h.s3.mockResolvedValue({});
  expect(await importAttachment(op)).toBe("front-document-id");
  expect(h.create).toHaveBeenCalledOnce(); expect(h.fetch).toHaveBeenCalledOnce();
});

it("retries a missing object using the existing row without changing filename provenance", async () => {
  h.existing.mockResolvedValue({ data: { id: "front-document-id", name: "Reviewed budget.pdf", uploadedName: "test.pdf" } });
  h.fetch.mockResolvedValue(new Response("pdf bytes"));
  await importAttachment(op);
  expect(h.create).not.toHaveBeenCalled();
  expect(h.s3.mock.calls[1][0].input).toMatchObject({ Key: "documents/ACCOUNT/a1/front-document-id/test.pdf", Body: Buffer.from("pdf bytes") });
});

it("downloads a provider-signed redirect without sending it the Front token", async () => {
  h.fetch.mockResolvedValueOnce(new Response("", { status: 302, headers: { location: "https://files.cloudfront.net/test.pdf?signed=1" } }))
    .mockResolvedValueOnce(new Response("pdf bytes"));
  await importAttachment(op);
  expect(h.fetch.mock.calls[0][1]).toMatchObject({ headers: { Authorization: "Bearer secret" }, redirect: "manual" });
  expect(h.fetch.mock.calls[1][0].href).toBe("https://files.cloudfront.net/test.pdf?signed=1");
  expect(h.fetch.mock.calls[1][1]).not.toHaveProperty("headers");
});
