import type { FrontMessage } from "./providers";

interface QueuedEmail {
  recipient?: string;
  subject?: string;
  text?: string;
  emailIdentity?: {
    frontId: string;
    channelId: string;
    senderEmail: string;
    signatureId: string;
    signatureMode: "FRONT";
  };
}

const mailbox = (value: string | undefined) => value?.trim().toLowerCase();
const lineEndings = (value: string) => value.replace(/\r\n?/g, "\n");

/** Match persisted send intent, without consulting a salesperson's current setup. */
export function matchesQueuedEmail(message: FrontMessage, queued: QueuedEmail): boolean {
  const recipient = mailbox(queued.recipient);
  if (message.is_inbound !== false || !recipient || !message.recipients?.some(
    item => item.role === "to" && mailbox(item.handle) === recipient
  )) return false;

  const identity = queued.emailIdentity;
  // Old operations already contain their whole signature. Never loosen those
  // comparisons to a body prefix, including after someone changes ownership.
  if (!identity) return message.text?.trim() === queued.text?.trim();

  const senders = message.recipients.filter(item => item.role === "from");
  if (identity.signatureMode !== "FRONT" || message.is_draft !== false ||
      !identity.frontId || message.author?.id !== identity.frontId ||
      !identity.channelId || !identity.signatureId || !mailbox(identity.senderEmail) ||
      senders.length !== 1 || mailbox(senders[0].handle) !== mailbox(identity.senderEmail) ||
      !queued.subject?.trim() || message.subject?.trim() !== queued.subject.trim() ||
      typeof queued.text !== "string" || typeof message.text !== "string") return false;

  const body = lineEndings(queued.text).trim();
  const delivered = lineEndings(message.text).trim();
  if (!body || !delivered.startsWith(body)) return false;
  const signature = delivered.slice(body.length);
  // Front appends its signature. Match all original prose exactly, permitting
  // only line-ending conversion and a whitespace separator before that footer.
  return /^\s/.test(signature) && signature.trim().length > 0;
}
