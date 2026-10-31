import { createHash } from "node:crypto";
import type { SendEmailCommandInput } from "@aws-sdk/client-sesv2";

export type MailKind = "login" | "invite" | "invoice" | "report" | "accounting" | "test";
export type Attachment = { filename: string; contentType: string; content: Uint8Array };
export type MailDetails = { idempotencyKey?: string; subject?: string; text?: string; html?: string; replyTo?: string; attachments?: Attachment[] };
export type Payload = { from: string; to: string[]; cc?: string[]; bcc?: string[]; reply_to?: string; subject: string; text?: string; html?: string; attachments?: { filename: string; content_type: string; content: string }[] };
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const ADDRESS = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
export function email(value: string) {
  if (/[\r\n]/.test(value)) throw new Error("Invalid email address.");
  const address = (value.match(/<([^<>]+)>$/)?.[1] ?? value).trim().toLowerCase();
  if (!ADDRESS.test(address)) throw new Error("Invalid email address.");
  return address;
}
export class MailDeliveryError extends Error {
  constructor(public readonly state: "DEFERRED" | "UNKNOWN" | "REJECTED" | "SUPPRESSED", public readonly operationKey: string) {
    super(state === "UNKNOWN" ? "Email acceptance is uncertain. Its delivery record is held for review; do not send a replacement."
      : state === "DEFERRED" ? "Email was not sent. It is saved for review and retry after the sending limit or service issue is resolved."
      : state === "SUPPRESSED" ? "Email was not sent because a recipient is suppressed. Review the saved delivery record."
      : "Email was rejected. Its delivery record is saved for review.");
    this.name = "MailDeliveryError";
  }
}
export function payload(input: SendEmailCommandInput, details: MailDetails): Payload {
  const from = input.FromEmailAddress ?? "";
  if (!email(from).endsWith("@protectmyhoa.com")) throw new Error("Unapproved transactional sender.");
  const destination = input.Destination;
  const to = destination?.ToAddresses?.map(email) ?? [];
  const cc = destination?.CcAddresses?.map(email);
  const bcc = destination?.BccAddresses?.map(email);
  if (!to.length || to.length + (cc?.length ?? 0) + (bcc?.length ?? 0) > 50) throw new Error("Invalid email recipient count.");
  const simple = input.Content?.Simple;
  if (input.Content?.Raw && !details.subject) throw new Error("Raw email requires its structured content and attachments.");
  const subject = details.subject ?? simple?.Subject?.Data ?? "";
  const text = details.text ?? simple?.Body?.Text?.Data;
  const html = details.html ?? simple?.Body?.Html?.Data;
  if (!subject || /[\r\n]/.test(subject) || (!text && !html)) throw new Error("Email content is incomplete.");
  const reply = details.replyTo ?? input.ReplyToAddresses?.[0];
  const result: Payload = { from, to, subject, ...(cc?.length ? { cc } : {}), ...(bcc?.length ? { bcc } : {}), ...(reply ? { reply_to: email(reply) } : {}), ...(text ? { text } : {}), ...(html ? { html } : {}) };
  if (details.attachments?.length) result.attachments = details.attachments.map(a => {
    if (!a.filename || /[\r\n]/.test(a.filename) || /[\r\n]/.test(a.contentType)) throw new Error("Invalid attachment metadata.");
    return { filename: a.filename, content_type: a.contentType, content: Buffer.from(a.content).toString("base64") };
  });
  if (Buffer.byteLength(JSON.stringify(result)) > 12 * 1024 * 1024) throw new Error("Email exceeds the approved attachment size limit.");
  return result;
}
export function assertDestination(kind: MailKind, body: Payload, env = process.env, now = Date.now()) {
  const secret = env.HOA_RESEND_SECRET_ARN ?? "";
  const branch = env.HOA_MIGRATION_BRANCH;
  const reportRuntime = branch === "codex-hoa-account-migration" ? "marketing-report-mplifyd1nuh9rw1hcuxomainbranch0e4fdbd849" : "marketing-report-ifyd1nuh9rw1hcuxostagingbranch3787a09124";
  const runtimeMatches = env.AWS_LAMBDA_FUNCTION_NAME?.startsWith("amplify-d1nuh9rw1hcuxo-") || (kind === "report" && env.AWS_LAMBDA_FUNCTION_NAME === reportRuntime);
  if (env.HOA_TRANSACTIONAL_MAIL_PROVIDER !== "resend" || env.HOA_MIGRATION_APP_ID !== "d1nuh9rw1hcuxo"
    || !["codex-hoa-account-migration", "codex-hoa-staging-migration"].includes(branch ?? "")
    || !["true", "false"].includes(env.HOA_MIGRATION_PREVIEW ?? "")
    || !secret.startsWith("arn:aws:secretsmanager:us-east-1:917680434255:secret:hoa/resend/sending-")
    || env.HOA_TRANSACTIONAL_MAIL_TABLE !== "HOA-TransactionalMail"
    || env.HOA_TRANSACTIONAL_MAIL_BUCKET !== "hoa-transactional-mail-917680434255-us-east-1"
    || !runtimeMatches) throw new Error("Transactional email is not bound to the HOA destination.");
  const recipients = [...body.to, ...(body.cc ?? []), ...(body.bcc ?? [])];
  if (env.HOA_MIGRATION_PREVIEW === "true") {
    const expiry = Date.parse(env.HOA_PREVIEW_ADMIN_LOGIN_EXPIRES_AT ?? "");
    if (branch !== "codex-hoa-account-migration" || !["login", "test"].includes(kind)
      || env.HOA_PREVIEW_ADMIN_LOGIN !== "true" || env.HOA_RESEND_PREVIEW_ENABLED !== "true" || !Number.isFinite(expiry) || now >= expiry
      || env.HOA_PREVIEW_ADMIN_EMAIL !== "jake@getgim.com" || recipients.length !== 1 || recipients[0] !== "jake@getgim.com"
      || email(body.from) !== "noreply@protectmyhoa.com" || !body.subject.startsWith("[Migration test]")) throw new Error("Email is disabled in this migration preview.");
  } else if ((env.HOA_TRANSACTIONAL_MAIL_RELEASE !== "true" || env.HOA_MIGRATION_WORKERS_ENABLED !== "true")) throw new Error("Transactional email release has not been approved.");
  if (branch === "codex-hoa-staging-migration" && recipients.some(a => a !== "jake@getgim.com")) throw new Error("Staging transactional email is restricted to the verified owner.");
}
