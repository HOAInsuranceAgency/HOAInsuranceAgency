import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AccountAccess } from "./access";
import { authorizeCustom, filterCustom } from "./custom";
import { AccessDenied, id, object, type Identity, type RecordData } from "./policy";
import { fileClient, fileSigningOptions } from "./file-signing";
const s3 = fileClient();
type Event = { identity?: Identity; info?: { fieldName?: string }; arguments?: RecordData; mode?: "read" | "write" | "custom-pre" | "custom-post"; model?: string; field?: string; operation?: string; previous?: unknown };
export async function handler(event: Event) {
  const access = new AccountAccess(event.identity), args = object(event.arguments);
  if (event.mode === "read") {
    if (access.admin || event.previous == null) return event.previous;
    const connection = object(event.previous);
    if (Array.isArray(connection.items)) {
      const items = await Promise.all(connection.items.map(async row => await access.canRecord(id(event.model), object(row)) ? row : null));
      return { ...connection, items: items.filter(Boolean) };
    }
    if (!await access.canRecord(id(event.model), connection)) throw new AccessDenied();
    return event.previous;
  }
  if (event.mode === "write") { await access.write(id(event.model), id(event.operation), object(args.input)); return event.previous; }
  if (event.mode === "custom-pre") { await authorizeCustom(access, id(event.field), args); return event.previous; }
  if (event.mode === "custom-post") return filterCustom(access, id(event.field), args, event.previous);
  const field = id(event.info?.fieldName);
  if (field === "crmAccess") return { actorId: access.actor, admin: access.admin, salespersonIds: [...await access.salespeople()] };
  if (field !== "crmFile") throw new AccessDenied();
  const path = typeof args.path === "string" ? args.path : "", operation = id(args.operation);
  const Bucket = process.env.STORAGE_BUCKET; if (!Bucket) throw new Error("File access is not configured");
  if (operation === "list") {
    if (!access.admin || path !== "templates/") throw new AccessDenied();
    const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: path, ContinuationToken: typeof args.nextToken === "string" && args.nextToken.length <= 16384 ? args.nextToken : undefined, MaxKeys: 100 }));
    return { items: page.Contents?.map(o => ({ path: o.Key, size: o.Size, lastModified: o.LastModified?.toISOString() })) ?? [], nextToken: page.NextContinuationToken };
  }
  if (!["read", "write", "delete"].includes(operation)) throw new AccessDenied();
  await access.path(path, operation as "read" | "write" | "delete");
  if (operation === "delete") { await s3.send(new DeleteObjectCommand({ Bucket, Key: path })); return { ok: true }; }
  if (operation === "write" && (!Number.isSafeInteger(args.sizeBytes) || Number(args.sizeBytes) <= 0 || Number(args.sizeBytes) > 100 * 1024 * 1024)) throw new Error("Upload a file between 1 byte and 100 MB");
  const command = operation === "read" ? new GetObjectCommand({ Bucket, Key: path }) : new PutObjectCommand({ Bucket, Key: path, ContentLength: Number(args.sizeBytes), ContentType: id(args.contentType) || "application/octet-stream" });
  return { url: await getSignedUrl(s3, command, fileSigningOptions), expiresAt: new Date(Date.now() + 60_000).toISOString() };
}
