import { client } from "./client";
import { privateApiCall, isRecord } from './apiResponse';
import { isHttpsUrl, type ApiRecord } from '../../../shared/apiResponse';
type FileInput = { path: string; options?: { contentType?: string; expiresIn?: number; validateObjectExistence?: boolean; contentDisposition?: { type: "attachment"; filename: string }; onProgress?: (progress: { transferredBytes: number; totalBytes: number }) => void } };
type SignedFile = { url: string; expiresAt: string };
type FilePage = { items: { path: string; size?: number; lastModified?: string }[]; nextToken?: string | null };
function signedFile(value: ApiRecord): value is ApiRecord & SignedFile {
  return isHttpsUrl(value.url) && typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt));
}
function filePage(value: ApiRecord): value is ApiRecord & FilePage {
  return Array.isArray(value.items) && value.items.every(item => isRecord(item) && typeof item.path === 'string'
    && (item.size === undefined || typeof item.size === 'number' && Number.isFinite(item.size) && item.size >= 0)
    && (item.lastModified === undefined || typeof item.lastModified === 'string'))
    && (value.nextToken == null || typeof value.nextToken === 'string' && !!value.nextToken);
}
async function request<T>(operation: string, path: string, validate: (value: ApiRecord) => value is ApiRecord & T, extra: { contentType?: string; sizeBytes?: number; nextToken?: string; downloadAs?: string; validateObjectExistence?: boolean } = {}): Promise<T> {
  return privateApiCall(client.mutations.crmFile({ operation, path, ...extra }), validate,
    { requireOk: false, fallback: 'File access could not be authorized. Please try again.' });
}
/** Familiar storage primitives, backed by current account assignment checks. */
export async function getUrl(input: FileInput) {
  const result = await request("read", input.path, signedFile, {
    ...(input.options?.contentDisposition ? { downloadAs: input.options.contentDisposition.filename } : {}),
    ...(input.options?.validateObjectExistence !== undefined ? { validateObjectExistence: input.options.validateObjectExistence } : {}),
  });
  return { url: new URL(result.url), expiresAt: new Date(result.expiresAt) };
}
export function uploadData(input: FileInput & { data: Blob | ArrayBuffer | ArrayBufferView | string }) {
  return { result: (async () => {
    const data = input.data instanceof Blob ? input.data : new Blob([input.data as BlobPart]);
    const contentType = input.options?.contentType || data.type || "application/octet-stream";
    const signed = await request("write", input.path, signedFile, { contentType, sizeBytes: data.size });
    const response = await fetch(signed.url, { method: "PUT", headers: { "Content-Type": contentType }, body: data });
    if (!response.ok) throw new Error("The file could not be uploaded. Please try again.");
    input.options?.onProgress?.({ transferredBytes: data.size, totalBytes: data.size });
    return { path: input.path };
  })() };
}
export async function remove(input: FileInput) { await request("delete", input.path, (value): value is ApiRecord => isRecord(value)); return { path: input.path }; }
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
  const seenTokens = new Set<string>();
  do {
    const result = await request("list", input.path, filePage, { nextToken });
    items.push(...(result.items ?? []).map(item => ({ ...item, lastModified: item.lastModified ? new Date(item.lastModified) : undefined })));
    nextToken = result.nextToken ?? undefined;
    if (nextToken) {
      if (seenTokens.has(nextToken)) throw new Error('The file list could not finish. Please retry.');
      seenTokens.add(nextToken);
    }
  } while (nextToken);
  return { items };
}
