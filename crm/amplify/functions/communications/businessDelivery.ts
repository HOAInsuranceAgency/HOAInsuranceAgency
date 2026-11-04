import { createHash } from "node:crypto";
import type { Communication } from "../../../../shared/leadWorkflow";
import { contactProgress } from "../../../../shared/contactProgress";
import { get, row, save, commit, put, check, issue, type Write } from "./store";
import { permittedConversation } from "./providers";
import { dataClient } from "./data";
import { currentMessage } from "../../../../shared/serviceEvidence";
import { resolveIssue } from "./routing";
import { downloadFrontAttachment } from "./attachments";
import { applyBusinessAttempt, quoteProjectionTimestamp } from "./businessHandoff";
export { businessDeliveryContext, previewBusinessDelivery, prepareBusinessDraft, historyBusinessDeliveries, reconcileBusinessDraft } from "./businessHandoff";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
interface Delivery {
  accountId: string; kind: "QUOTE" | "CERTIFICATE" | "DOCUMENT"; recordId: string; recordVersion: string;
  conversationId: string; recipient: string; reference: string; facts: string[]; state: "PREPARED" | "SENT" | "FAILED";
  files: { filename: string; size: number; sha256: string }[]; messageId?: string;
}
/** A stored preparation plus the verified sent contents supplies the delivery evidence. */
export async function applyBusinessDelivery(comm: Communication) {
  await applyBusinessAttempt(comm);
  if (!comm.accountId || comm.provider !== "front" || comm.direction !== "OUTBOUND" || comm.frontDraft !== false) return;
  const text = currentMessage(comm.text);
  const references = [...new Set(text.match(/HOA-[A-F0-9]{12}/g) ?? [])].slice(0,10);
  for (const reference of references) {
    const candidate = await get<Delivery>(`delivery:${reference}`);
    if (!candidate || candidate.accountId !== comm.accountId) continue;
    const d = candidate.data;
    if (comm.status === "FAILED") { if (d.messageId === comm.providerId) await save(row("BUSINESS_DELIVERY", candidate.id, { ...d, state: "FAILED", failure: "Front reported the historical sent message failed." }, { accountId: comm.accountId, previous: candidate }), candidate); continue; }
    if (["SENT", "FAILED"].includes(d.state) || contactProgress(comm) !== "CONTACT" || !comm.conversationId || !comm.to?.includes(d.recipient) || !text.includes(d.reference) || candidate.createdAt > comm.at) continue;
    const canonical = await permittedConversation(d.conversationId), current = await permittedConversation(comm.conversationId);
    const link = await get<{ accountId: string; purpose?: string }>(`front-link:${canonical.id}`);
    if (canonical.id !== current.id || !link || link.data.accountId !== comm.accountId || link.data.purpose !== "PROSPECT") continue;
    if (!d.facts.every(f => text.includes(f))) continue;
    let valid = true;
    const remaining = [...(comm.attachments ?? [])];
    if (remaining.length !== d.files.length || new Set(remaining.map(a => a.id)).size !== remaining.length) continue;
    const digests = new Map<string, string>();
    for (const file of d.files) {
      let matched = -1;
      for (let i = 0; i < remaining.length; i++) {
        const attachment = remaining[i]; if (attachment.filename !== file.filename || attachment.size !== file.size) continue;
        let value = digests.get(attachment.id); if (!value) { value = digest(await downloadFrontAttachment(attachment.id)); digests.set(attachment.id, value); }
        if (value === file.sha256) { matched = i; break; }
      }
      if (matched < 0) { valid = false; break; } remaining.splice(matched, 1);
    }
    if (!valid) continue;
    const source = await get<Communication>(comm.id); if (!source) return;
    const projection: Write[] = [];
    if (d.kind === "QUOTE") {
      const q = await (await dataClient()).models.Quote.get({ id: d.recordId });
      if (q.errors?.length || !q.data || q.data.accountId !== comm.accountId) { await issue(candidate.id, "Review the historical quote proof before recording presentation.", comm.accountId); continue; }
      if (!process.env.QUOTE_TABLE) throw new Error("Business delivery storage needs configuration");
      projection.push({ Update: { TableName: process.env.QUOTE_TABLE, Key: { id: d.recordId }, UpdateExpression: "SET presentedAt = if_not_exists(presentedAt, :at), updatedAt = :processed, lastWriteBy = :actor, #status = :presented", ConditionExpression: "updatedAt = :old AND #status = :quoted", ExpressionAttributeValues: { ":at": comm.at, ":processed": quoteProjectionTimestamp(q.data.updatedAt), ":old": d.recordVersion, ":actor": "communication-delivery", ":presented": "PRESENTED", ":quoted": "QUOTED" }, ExpressionAttributeNames: { "#status": "status" } } });
    }
    try {
      await commit([check(source), check(link), put(row("BUSINESS_DELIVERY", candidate.id, { ...d, state: "SENT", sentAt: comm.at, messageId: comm.providerId }, { accountId: comm.accountId, previous: candidate }), candidate), ...projection]);
      await resolveIssue(candidate.id);
    } catch (e) { await issue(candidate.id, "The sent document or quote changed after its draft was prepared. Review the current business record before recording delivery.", comm.accountId); throw e; }
  }
}
