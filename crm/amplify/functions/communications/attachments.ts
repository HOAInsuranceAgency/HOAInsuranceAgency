import { S3Client, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { credentials } from "./config";
import { permittedConversation, front, messageConversation, type FrontMessage } from "./providers";
import { get, row, save, hash } from "./store";
import { dataClient } from "./data";
import type { Operation } from "./operations";
const s3 = new S3Client();
const MAX_BYTES = 25 * 1024 * 1024;
export async function importAttachment(op: Operation) {
  if (!op.sourceMessageId || !op.attachmentId || !/^msg_[a-z0-9]+$/.test(op.sourceMessageId) || !/^fil_[a-z0-9]+$/.test(op.attachmentId)) throw new Error("Invalid source attachment");
  const message = await front<FrontMessage>(`/messages/${op.sourceMessageId}`), cnv = messageConversation(message);
  if (!cnv) throw new Error("Source conversation is unavailable");
  await permittedConversation(cnv);
  const link = await get<{ accountId: string }>(`front-link:${cnv}`);
  if (link?.data.accountId !== op.accountId) throw new Error("This attachment is not linked to the selected account");
  const attachment = message.attachments?.find(a => a.id === op.attachmentId);
  if (!attachment || attachment.size > MAX_BYTES) throw new Error("Choose an attachment no larger than 25 MB");
  const documentId = `front-${hash(`${op.accountId}:${message.id}:${attachment.id}`).slice(0, 40)}`;
  const filename = attachment.filename.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 200) || "attachment";
  const key = `documents/ACCOUNT/${op.accountId}/${documentId}/${filename}`, bucket = process.env.DOCUMENT_BUCKET;
  if (!bucket) throw new Error("Document storage needs configuration");
  const client = await dataClient(), existing = await client.models.Document.get({ id: documentId });
  if (existing.errors?.length) throw new Error("Could not check existing CRM document");
  let exists = false;
  try { await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); exists = true; }
  catch(e) { if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw e; }
  let downloaded: Buffer | undefined;
  if (!exists || !existing.data) {
    downloaded = await downloadFrontAttachment(attachment.id);
  }
  // Validate and fully download before making a document visible. Rejected
  // hosts, oversized bodies and failed downloads cannot leave empty documents.
  if (!existing.data) {
    const created = await client.models.Document.create({ id: documentId, entityType: "ACCOUNT", entityId: op.accountId, name: filename, s3Key: key,
      contentType: attachment.content_type, sizeBytes: downloaded?.length ?? attachment.size, uploadedBy: op.requestedBy, lastWriteBy: "front-attachment", ocrStatus: "PENDING" });
    if (created.errors?.length) throw new Error("Could not create CRM document");
  }
  if (downloaded) await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: downloaded, ContentType: attachment.content_type || "application/octet-stream" }));
  const old = await get(`attachment:${documentId}`);
  if (!old) await save(row("ATTACHMENT", `attachment:${documentId}`, { accountId: op.accountId, documentId, messageId: message.id, attachmentId: attachment.id }, { accountId: op.accountId }));
  return documentId;
}

export async function downloadFrontAttachment(attachmentId: string) {
  if (!/^fil_[a-z0-9]+$/.test(attachmentId)) throw new Error("Invalid Front attachment");
    const token = (await credentials()).frontToken;
    let response = await fetch(`https://api2.frontapp.com/download/${attachmentId}`, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (response.status >= 300 && response.status < 400) {
      const url = new URL(response.headers.get("location") ?? "");
      // A provider-signed file URL is fetched without forwarding the API token.
      if (url.protocol !== "https:" || url.username || url.password || !/\.(?:amazonaws\.com|cloudfront\.net)$/.test(url.hostname)) throw new Error("Front attachment download location needs review");
      response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000) });
    }
    if (!response.ok || !response.body) throw new Error(`Attachment download failed (${response.status})`);
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    while (true) { const value = await reader.read(); if (value.done) break; size += value.value.byteLength; if (size > MAX_BYTES) { await reader.cancel(); throw new Error("Attachment exceeds the 25 MB limit"); } chunks.push(value.value); }
    return Buffer.concat(chunks);
}
