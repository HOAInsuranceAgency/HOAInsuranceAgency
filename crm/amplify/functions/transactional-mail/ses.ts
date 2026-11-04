import { SendEmailCommand, type SendEmailCommandInput } from "@aws-sdk/client-sesv2";
import { hash, SES_IDENTITY_ARN, type MailKind, type Payload } from "./contract";

/** Build from the canonical saved envelope; the SDK encodes attachment bytes once. */
export function sesCommand(body: Payload, configurationSet: string, environment: string, kind: MailKind, operationKey: string): SendEmailCommand {
  const input: SendEmailCommandInput = {
    FromEmailAddress: body.from,
    FromEmailAddressIdentityArn: SES_IDENTITY_ARN,
    Destination: { ToAddresses: body.to, ...(body.cc?.length ? { CcAddresses: body.cc } : {}), ...(body.bcc?.length ? { BccAddresses: body.bcc } : {}) },
    ...(body.reply_to ? { ReplyToAddresses: [body.reply_to] } : {}),
    ConfigurationSetName: configurationSet,
    EmailTags: [{ Name: "HOAEnvironment", Value: environment }, { Name: "HOAMailKind", Value: kind }, { Name: "HOAOperation", Value: hash(operationKey) }],
    Content: { Simple: {
      Subject: { Data: body.subject, Charset: "UTF-8" },
      Body: { ...(body.text ? { Text: { Data: body.text, Charset: "UTF-8" } } : {}), ...(body.html ? { Html: { Data: body.html, Charset: "UTF-8" } } : {}) },
      ...(body.attachments?.length ? { Attachments: body.attachments.map(a => {
        const content = Buffer.from(a.content, "base64");
        if (content.toString("base64") !== a.content) throw new Error("Saved attachment encoding is invalid.");
        return { FileName: a.filename, ContentType: a.content_type, ContentDisposition: "ATTACHMENT", ContentTransferEncoding: "BASE64", RawContent: content };
      }) } : {}),
    } },
  };
  return new SendEmailCommand(input);
}

/** SES has no send idempotency token. Only explicit 4xx rejections are known unsent. */
export function sesFailure(error: unknown): { state: "DEFERRED" | "REJECTED" | "UNKNOWN"; reason: string } {
  const e = error as { name?: unknown; $metadata?: { httpStatusCode?: number } };
  const code = e?.$metadata?.httpStatusCode;
  if (!Number.isInteger(code) || code! < 400 || code! >= 500) return { state: "UNKNOWN", reason: "ses_acceptance_uncertain" };
  if (["TooManyRequestsException", "LimitExceededException", "ThrottlingException"].includes(String(e.name))) return { state: "DEFERRED", reason: "rate_limit_exceeded" };
  if (["BadRequestException", "MessageRejected", "MailFromDomainNotVerifiedException", "AccountSuspendedException", "SendingPausedException", "NotFoundException", "ForbiddenException", "AccessDeniedException"].includes(String(e.name))) return { state: "REJECTED", reason: "ses_rejected" };
  return { state: "UNKNOWN", reason: "ses_acceptance_uncertain" };
}
