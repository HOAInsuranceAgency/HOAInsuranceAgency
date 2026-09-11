import { randomUUID } from "node:crypto";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
import type { Communication } from "../../../../shared/leadWorkflow";
import { contactProgress } from "../../../../shared/contactProgress";
import { usableQuote } from "../../../../shared/renewalPolicy";
import { dataClient } from "./data";
import { ensureWorkflow } from "./workflow";
import { config } from "./config";
import { front, assertRecipient, verifyEmailChannel, permittedConversation, htmlEscape, type FrontMessage } from "./providers";
import { get, row, save, commit, put, check, issue } from "./store";
import { currentMessage } from "../../../../shared/serviceEvidence";
import { resolveIssue } from "./routing";
import { downloadFrontAttachment } from "./attachments";

const s3 = new S3Client(), MAX = 25 * 1024 * 1024;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
interface Delivery {
  accountId: string; kind: "QUOTE" | "CERTIFICATE" | "DOCUMENT"; recordId: string; recordVersion: string;
  conversationId: string; recipient: string; reference: string; facts: string[]; state: "PREPARED" | "SENT";
  files: { filename: string; size: number; sha256: string }[]; messageId?: string;
}
/** Preparing a native draft is work, but does not mark anything presented or delivered. */
export async function prepareBusinessDraft(input: { accountId: string; conversationId: string; kind: Delivery["kind"]; recordId: string }, actor: string) {
  if (!["QUOTE", "CERTIFICATE", "DOCUMENT"].includes(input.kind)) throw new Error("Choose a quote, certificate or document");
  const wf = await ensureWorkflow(input.accountId), c = await config();
  if (!c.frontChannelId) throw new Error("Connect the sending mailbox first");
  await verifyEmailChannel();
  await permittedConversation(input.conversationId);
  const link = await get<{ accountId: string; purpose: string }>(`front-link:${input.conversationId}`);
  if (link?.data.accountId !== input.accountId || link.data.purpose === "CARRIER") throw new Error("Choose the linked client conversation");
  const messages = await front<{ _results: FrontMessage[] }>(`/conversations/${input.conversationId}/messages?limit=100`);
  const original = messages._results.find(m => m.is_inbound && m.recipients?.some(r => r.role === "from"));
  const recipient = original?.recipients?.find(r => r.role === "from")?.handle;
  if (!recipient || !original?.id) throw new Error("Open the client's email conversation before preparing delivery");
  await assertRecipient(recipient);
  const client = await dataClient();
  const reference = `HOA-${randomUUID().replace(/-/g, "").slice(0,12).toUpperCase()}`, id = `delivery:${reference}`;
  let recordVersion: string, heading: string, facts: string[] = [], file: { filename: string; key: string } | undefined;
  if (input.kind === "QUOTE") {
    const q = await client.models.Quote.get({ id: input.recordId });
    if (q.errors?.length || !q.data || q.data.status !== "QUOTED" || q.data.premium == null || !q.data.lines?.length || !q.data.effectiveDate || !usableQuote(q.data, { accountId: input.accountId, term: q.data.effectiveDate, lines: [], policyId: q.data.renewalPolicyId ?? undefined }, new Date().toISOString())) throw new Error("Finish the usable quote before presenting it");
    recordVersion = q.data.updatedAt; heading = "Your insurance quote";
    facts = [`Premium: ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(q.data.premium)}`, `Coverage: ${q.data.lines.filter(Boolean).join(", ")}`, `Term: ${q.data.effectiveDate} to ${q.data.expirationDate}`];
    if (q.data.carrierId) { const carrier = await client.models.Carrier.get({ id: q.data.carrierId }); if (carrier.errors?.length || !carrier.data) throw new Error("Could not verify the quoted carrier"); facts.unshift(`Carrier: ${carrier.data.name}`); }
  } else if (input.kind === "CERTIFICATE") {
    const cert = await client.models.Certificate.get({ id: input.recordId });
    if (cert.errors?.length || !cert.data || cert.data.accountId !== input.accountId || !cert.data.s3Key) throw new Error("Generate the certificate before sending it");
    recordVersion = cert.data.updatedAt; heading = "Your certificate of insurance";
    facts = [`Certificate holder: ${cert.data.holderName}`];
    file = { filename: `Certificate ${cert.data.certificateNumber ?? cert.data.id}.pdf`, key: cert.data.s3Key };
  } else {
    const doc = await client.models.Document.get({ id: input.recordId });
    if (doc.errors?.length || !doc.data || doc.data.entityId !== input.accountId || doc.data.entityType !== "ACCOUNT" || !doc.data.s3Key) throw new Error("Choose a document on this account");
    recordVersion = doc.data.updatedAt; heading = "Your requested document"; facts = [`Document: ${doc.data.name}`];
    file = { filename: doc.data.name, key: doc.data.s3Key };
  }
  const files: Delivery["files"] = [], attachments: { filename: string; url: string; contentType: string }[] = [];
  if (file) {
    if (!file.key.startsWith(`certificates/${input.accountId}/`) && !file.key.startsWith(`documents/ACCOUNT/${input.accountId}/`)) throw new Error("Document storage does not match this account");
    const command = new GetObjectCommand({ Bucket: process.env.DOCUMENT_BUCKET, Key: file.key });
    const object = await s3.send(command);
    if (!object.Body || !object.ContentLength || object.ContentLength > MAX) throw new Error("Choose a file no larger than 25 MB");
    const bytes = await object.Body.transformToByteArray();
    files.push({ filename: file.filename, size: bytes.length, sha256: digest(bytes) });
    attachments.push({ filename: file.filename, url: await getSignedUrl(s3, command, { expiresIn: 600 }), contentType: object.ContentType ?? "application/octet-stream" });
  }
  const body = `<h2>${htmlEscape(heading)}</h2><p>${htmlEscape(wf.data.name)}</p>${facts.map(f => `<p>${htmlEscape(f)}</p>`).join("")}<p>${input.kind === "QUOTE" ? "Please review this quote and let us know if you would like to discuss it. Coverage is subject to the carrier's terms and confirmation of binding." : "Please find the requested document attached."}</p><p style="font-size:11px;color:#66768b">Reference: ${reference}</p>`;
  await save(row("BUSINESS_DELIVERY", id, { ...input, recordVersion, recipient, reference, facts, files, state: "PREPARED", preparedBy: actor } satisfies Delivery & { preparedBy: string }, { accountId: input.accountId }));
  return { channelId: c.frontChannelId, originalMessageId: original.id, recipient, subject: heading, body, attachments };
}

/** A stored preparation plus the verified sent contents supplies the delivery evidence. */
export async function applyBusinessDelivery(comm: Communication) {
  if (!comm.accountId || comm.provider !== "front" || comm.direction !== "OUTBOUND" || comm.frontDraft !== false || contactProgress(comm) !== "CONTACT") return;
  const text = currentMessage(comm.text);
  const references = [...new Set(text.match(/HOA-[A-F0-9]{12}/g) ?? [])].slice(0,10);
  for (const reference of references) {
    const candidate = await get<Delivery>(`delivery:${reference}`);
    if (!candidate || candidate.accountId !== comm.accountId) continue;
    const d = candidate.data;
    if (d.state === "SENT" || d.conversationId !== comm.conversationId || !comm.to?.includes(d.recipient) || !text.includes(d.reference) || candidate.createdAt > comm.at) continue;
    if (!d.facts.every(f => text.includes(f))) continue;
    let valid = true;
    for (const file of d.files) {
      const attachment = comm.attachments?.find(a => a.filename === file.filename && a.size === file.size);
      if (!attachment || digest(await downloadFrontAttachment(attachment.id)) !== file.sha256) { valid = false; break; }
    }
    if (!valid) continue;
    const table = process.env[`${d.kind}_TABLE`]; if (!table) throw new Error("Business delivery storage needs configuration");
    const source = await get<Communication>(comm.id); if (!source) return;
    const attribute = d.kind === "QUOTE" ? "presentedAt" : "deliveredAt";
    const values = { ":at": comm.at, ":old": d.recordVersion, ":actor": "communication-delivery", ...(d.kind === "QUOTE" ? { ":presented": "PRESENTED", ":quoted": "QUOTED" } : {}) };
    try {
      await commit([check(source), put(row("BUSINESS_DELIVERY", candidate.id, { ...d, state: "SENT", messageId: comm.providerId }, { accountId: comm.accountId, previous: candidate }), candidate),
        { Update: { TableName: table, Key: { id: d.recordId }, UpdateExpression: `SET ${attribute} = :at, updatedAt = :at, lastWriteBy = :actor${d.kind === "QUOTE" ? ", #status = :presented" : ""}`, ConditionExpression: `updatedAt = :old${d.kind === "QUOTE" ? " AND #status = :quoted" : ""}`, ExpressionAttributeValues: values, ...(d.kind === "QUOTE" ? { ExpressionAttributeNames: { "#status": "status" } } : {}) } }]);
      await resolveIssue(candidate.id);
    } catch (e) { await issue(candidate.id, "The sent document or quote changed after its draft was prepared. Review the current business record before recording delivery.", comm.accountId); throw e; }
  }
}
