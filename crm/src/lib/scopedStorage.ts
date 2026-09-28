import { client } from "./client";
type FileInput = { path: string; options?: { contentType?: string; expiresIn?: number; validateObjectExistence?: boolean; onProgress?: (progress: { transferredBytes: number; totalBytes: number }) => void } };
type FileResult = { url: string; expiresAt: string; items?: { path: string; size?: number; lastModified?: string }[]; nextToken?: string };
async function request(operation: string, path: string, extra: { contentType?: string; sizeBytes?: number; nextToken?: string } = {}): Promise<FileResult> {
  const response = await client.mutations.crmFile({ operation, path, ...extra });
  if (response.errors?.length) throw new Error(response.errors[0].message);
  const value = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
  if (!value || typeof value !== "object") throw new Error("File access could not be authorized. Please try again.");
  return value as FileResult;
}
/** Familiar storage primitives, backed by current account assignment checks. */
export async function getUrl(input: FileInput) {
  const result = await request("read", input.path);
  return { url: new URL(result.url), expiresAt: new Date(result.expiresAt) };
}
export function uploadData(input: FileInput & { data: Blob | ArrayBuffer | ArrayBufferView | string }) {
  return { result: (async () => {
    const data = input.data instanceof Blob ? input.data : new Blob([input.data as BlobPart]);
    const contentType = input.options?.contentType || data.type || "application/octet-stream";
    const signed = await request("write", input.path, { contentType, sizeBytes: data.size });
    const response = await fetch(signed.url, { method: "PUT", headers: { "Content-Type": contentType }, body: data });
    if (!response.ok) throw new Error("The file could not be uploaded. Please try again.");
    input.options?.onProgress?.({ transferredBytes: data.size, totalBytes: data.size });
    return { path: input.path };
  })() };
}
export async function remove(input: FileInput) { await request("delete", input.path); return { path: input.path }; }
export function downloadData(input: FileInput) {
  return { result: (async () => {
    const { url } = await getUrl(input);
    const response = await fetch(url);
    if (!response.ok) throw new Error("The file could not be downloaded. Please try again.");
    return { body: { arrayBuffer: () => response.arrayBuffer(), blob: () => response.blob(), text: () => response.text() } };
  })() };
}
export async function list(input: FileInput) {
  const items: { path: string; size?: number; lastModified?: Date }[] = [];
  let nextToken: string | undefined;
  do {
    const result = await request("list", input.path, { nextToken });
    items.push(...(result.items ?? []).map(item => ({ ...item, lastModified: item.lastModified ? new Date(item.lastModified) : undefined })));
    nextToken = result.nextToken;
  } while (nextToken);
  return { items };
}
