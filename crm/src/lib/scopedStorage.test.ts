import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ crmFile: vi.fn(), fetch: vi.fn() }));
vi.mock("./client", () => ({ client: { mutations: { crmFile: h.crmFile } } }));
import { getUrl, uploadData, remove, list } from "./scopedStorage";
import { getFileUrl } from "./storage";
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("fetch", h.fetch);
  h.crmFile.mockResolvedValue({ data: JSON.stringify({ url: "https://files.example.test/authorized", expiresAt: "2026-09-25T12:00:00Z" }) });
  h.fetch.mockResolvedValue({ ok: true });
});
afterEach(() => vi.unstubAllGlobals());
it("obtains a fresh authorization for every download", async () => {
  expect((await getUrl({ path: "generated/a/form.pdf" })).url.href).toBe("https://files.example.test/authorized");
  await getUrl({ path: "generated/a/form.pdf" });
  expect(h.crmFile).toHaveBeenCalledTimes(2);
  expect(h.crmFile).toHaveBeenCalledWith({ operation: "read", path: "generated/a/form.pdf" });
});
it("preserves download filenames and existence validation through the real getFileUrl wrapper", async () => {
  expect(await getFileUrl("generated/a/form.pdf", { validate: true, downloadAs: "2026 budget.pdf" })).toBe("https://files.example.test/authorized");
  expect(h.crmFile).toHaveBeenCalledWith({ operation: "read", path: "generated/a/form.pdf", downloadAs: "2026 budget.pdf", validateObjectExistence: true });
});
it("keeps previews inline and skips optional existence checks by default", async () => {
  await getFileUrl("generated/a/form.pdf");
  expect(h.crmFile).toHaveBeenCalledWith({ operation: "read", path: "generated/a/form.pdf", validateObjectExistence: false });
});
it("surfaces missing-file errors instead of returning a signed URL", async () => {
  h.crmFile.mockResolvedValue({ errors: [{ message: "The file was not found" }] });
  await expect(getFileUrl("generated/a/missing.pdf", { validate: true, downloadAs: "Missing.pdf" })).rejects.toThrow("not found");
});
it("does not upload when the backend denies access", async () => {
  h.crmFile.mockResolvedValue({ errors: [{ message: "Access denied" }] });
  await expect(uploadData({ path: "generated/b/form.pdf", data: "test" }).result).rejects.toThrow("Access denied");
  expect(h.fetch).not.toHaveBeenCalled();
});
it("uploads only to the authorized URL with matching content type and size", async () => {
  await uploadData({ path: "generated/a/form.pdf", data: "test", options: { contentType: "application/pdf" } }).result;
  expect(h.crmFile).toHaveBeenCalledWith({ operation: "write", path: "generated/a/form.pdf", contentType: "application/pdf", sizeBytes: 4 });
  expect(h.fetch).toHaveBeenCalledWith("https://files.example.test/authorized", expect.objectContaining({ method: "PUT", headers: { "Content-Type": "application/pdf" } }));
});
it("surfaces upload failures and authorizes deletion on the server", async () => {
  h.fetch.mockResolvedValue({ ok: false });
  await expect(uploadData({ path: "generated/a/f.pdf", data: "test" }).result).rejects.toThrow("uploaded");
  await remove({ path: "generated/a/f.pdf" });
  expect(h.crmFile).toHaveBeenLastCalledWith({ operation: "delete", path: "generated/a/f.pdf" });
});
it("follows every authorized template-list page", async () => {
  h.crmFile.mockResolvedValueOnce({ data: { items: [{ path: "templates/a.pdf" }], nextToken: "second" } }).mockResolvedValueOnce({ data: { items: [{ path: "templates/b.pdf" }] } });
  expect((await list({ path: "templates/" })).items.map(i => i.path)).toEqual(["templates/a.pdf", "templates/b.pdf"]);
  expect(h.crmFile).toHaveBeenLastCalledWith({ operation: "list", path: "templates/", nextToken: "second" });
});
