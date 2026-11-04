import { createHash } from "node:crypto";
import type { SendEmailCommandInput } from "@aws-sdk/client-sesv2";

export type MailKind = "login" | "invite" | "invoice" | "report" | "accounting" | "test";
/** Historical ledger values; new sends are SES-only. Never relabel old rows. */
export type MailProvider = "resend" | "ses";
export const SES_IDENTITY_ARN = "arn:aws:ses:us-east-1:917680434255:identity/protectmyhoa.com";
export type Attachment = { filename: string; contentType: string; content: Uint8Array };
export type MailDetails = { idempotencyKey?: string; subject?: string; text?: string; html?: string; replyTo?: string; attachments?: Attachment[] };
export type Payload = { from: string; to: string[]; cc?: string[]; bcc?: string[]; reply_to?: string; subject: string; text?: string; html?: string; attachments?: { filename: string; content_type: string; content: string }[] };
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const ADDRESS = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
export const ledgerMailProvider = (value: string | undefined): value is MailProvider => value === "resend" || value === "ses";
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
export function sesConfigurationSet(env = process.env): string {
  const branches: Record<string, string> = { "codex-hoa-account-migration": "hoa-transactional-main", "codex-hoa-staging-migration": "hoa-transactional-staging" };
  const expected = branches[env.HOA_MIGRATION_BRANCH ?? ""];
  if (!expected || env.AWS_REGION !== "us-east-1" || env.HOA_SES_IDENTITY_ARN !== SES_IDENTITY_ARN
    || env.HOA_SES_CONFIGURATION_SET !== expected) throw new Error("SES email is not bound to its reviewed identity and configuration set.");
  return expected;
}
export function assertVerificationWindow(env = process.env, now = Date.now()) {
  const raw = env.HOA_SES_VERIFICATION_EXPIRES_AT ?? "";
  const expiry = Date.parse(raw);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw) || !Number.isFinite(expiry)
    || new Date(expiry).toISOString() !== raw || expiry <= now || expiry > now + 60 * 60 * 1000) throw new Error("SES verification is not enabled for this window.");
}
export function assertDestination(kind: MailKind, body: Payload, env = process.env, now = Date.now()) {
  const branch = env.HOA_MIGRATION_BRANCH;
  const reportRuntime = branch === "codex-hoa-account-migration" ? "marketing-report-mplifyd1nuh9rw1hcuxomainbranch0e4fdbd849" : "marketing-report-ifyd1nuh9rw1hcuxostagingbranch3787a09124";
  const runtimeMatches = env.AWS_LAMBDA_FUNCTION_NAME?.startsWith("amplify-d1nuh9rw1hcuxo-") || (kind === "report" && env.AWS_LAMBDA_FUNCTION_NAME === reportRuntime);
  if (env.HOA_TRANSACTIONAL_MAIL_PROVIDER !== "ses" || env.HOA_MIGRATION_APP_ID !== "d1nuh9rw1hcuxo"
    || !["codex-hoa-account-migration", "codex-hoa-staging-migration"].includes(branch ?? "")
    || env.HOA_MIGRATION_PREVIEW !== "false"
    || env.HOA_TRANSACTIONAL_MAIL_TABLE !== "HOA-TransactionalMail"
    || env.HOA_TRANSACTIONAL_MAIL_BUCKET !== "hoa-transactional-mail-917680434255-us-east-1"
    || !runtimeMatches) throw new Error("Transactional email is not bound to the released HOA destination.");
  sesConfigurationSet(env);
  if (env.HOA_TRANSACTIONAL_MAIL_RELEASE !== "true" || env.HOA_MIGRATION_WORKERS_ENABLED !== "true") throw new Error("Transactional email release has not been approved.");
  const stage = branch === "codex-hoa-staging-migration";
  const senders = stage ? ["noreply@protectmyhoa.com", "jake+testing@protectmyhoa.com"] : ["noreply@protectmyhoa.com", "insurance@protectmyhoa.com"];
  if (!senders.includes(email(body.from))) throw new Error("Transactional sender is not configured for this destination.");
  const recipients = [...body.to, ...(body.cc ?? []), ...(body.bcc ?? [])];
  if (stage && recipients.some(a => a !== "jake@getgim.com")) throw new Error("Staging transactional email is restricted to the verified owner.");
  if (kind === "test") {
    assertVerificationWindow(env, now);
    if (!env.AWS_LAMBDA_FUNCTION_NAME?.toLowerCase().includes("mailverification") || recipients.length !== 1 || recipients[0] !== "jake@getgim.com"
      || body.cc?.length || body.bcc?.length) throw new Error("SES verification is restricted to the owner and verification runtime.");
  }
}
