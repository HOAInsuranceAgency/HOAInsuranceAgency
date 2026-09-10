import { normalizePhone, type Communication, type LeadTask } from "./leadWorkflow";

/** Provider activity is the evidence. A draft, failed send or ringing call is not contact. */
export function contactProgress(c: Communication): "CONTACT" | "ATTEMPT" | undefined {
  if (c.channel === "CALL") {
    if (!c.endedAt) return;
    if (c.status === "CONNECTED") return "CONTACT";
    if (c.direction === "OUTBOUND" && c.status === "MISSED") return "ATTEMPT";
    return;
  }
  if (c.frontDraft || c.direction !== "OUTBOUND" || !["EMAIL", "SMS"].includes(c.channel) || !["SENT", "DELIVERED"].includes(c.status)) return;
  if (c.classification === "AUTOMATIC" || c.classification === "REVIEW") return;
  if (!c.text?.trim() && !c.attachments?.length) return;
  return "CONTACT";
}

export const contactAt = (c: Communication) => c.endedAt ?? c.at;
const handles = (c: Communication) => (c.direction === "INBOUND" ? [c.from] : c.to ?? [])
  .filter((s): s is string => !!s).map(s => s.includes("@") ? s.trim().toLowerCase() : normalizePhone(s)).filter(Boolean);

/** Never resolve another account, carrier thread, contact, or newer request. */
export type ContactPair = { email?: string | null; phone?: string | null };
export function sameContact(a: Communication, b: Communication, contacts: ContactPair[] = []): boolean {
  if (!a.accountId || a.accountId !== b.accountId || (a.purpose ?? "PROSPECT") !== (b.purpose ?? "PROSPECT")) return false;
  const left = handles(a), right = handles(b);
  const sameChannelType = (a.channel === "EMAIL") === (b.channel === "EMAIL");
  // A linked conversation is also an explicit cross-channel association.
  if (a.conversationId && a.conversationId === b.conversationId) return !sameChannelType || !left.length || !right.length || left.some(s => right.includes(s));
  if (left.some(s => right.includes(s))) return true;
  // Cross-channel identity comes from one saved contact on this account.
  return !sameChannelType && contacts.some(c => {
    const pair = [c.email?.trim().toLowerCase(), c.phone ? normalizePhone(c.phone) : undefined].filter(Boolean);
    return left.some(s => pair.includes(s)) && right.some(s => pair.includes(s));
  });
}

export function automaticContactTask(task: LeadTask) {
  return ["RESPONSE", "CALLBACK", "CARRIER"].includes(task.kind) || !task.custom && task.kind === "FOLLOW_UP";
}
