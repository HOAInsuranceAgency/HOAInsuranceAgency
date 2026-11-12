import { TransactionalMailClient } from "../transactional-mail/client";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { getSigningSecret, mintToken, TOKEN_TTL_MS } from "./token";
import { migrationPreview } from "./migration";

const ses = new TransactionalMailClient("login");

/** Only private Cognito challenge metadata may identify a destination request. */
export function destinationLinkRequest(parameters: Record<string, string> | undefined, now = Date.now()) {
  const id = parameters?.requestId;
  const timestamp = parameters?.issuedAt;
  const issuedAt = typeof timestamp === "string" && /^(0|[1-9]\d*)$/.test(timestamp) ? Number(timestamp) : NaN;
  // Allow a small clock skew between separate Lambda hosts; never extend the
  // original 15-minute token lifetime when Cognito retries a challenge.
  if (parameters?.mode !== "destination" || typeof id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    || !Number.isSafeInteger(issuedAt) || issuedAt > now + 5_000
    || now - issuedAt >= TOKEN_TTL_MS) {
    throw new Error("Request a fresh sign-in link.");
  }
  return { requestId: id.toLowerCase(), issuedAt };
}

/** Called only after the destination guard and an explicit link request. */
export async function sendDestinationLink(email: string, sub: string, parameters: Record<string, string> | undefined) {
  const request = destinationLinkRequest(parameters);
  const token = mintToken(email, sub, await getSigningSecret(), request.issuedAt);
  const link = `${process.env.MAGIC_LINK_BASE_URL}/#magic=${encodeURIComponent(token)}`;
  const preview = migrationPreview();
  await ses.send(new SendEmailCommand({
    FromEmailAddress: process.env.MAGIC_LINK_FROM,
    Destination: { ToAddresses: [email] },
    ...(preview ? {
      ConfigurationSetName: process.env.HOA_PREVIEW_SES_CONFIGURATION_SET,
      EmailTags: [{ Name: "MigrationTest", Value: "hoa-preview-20261029" }],
    } : {}),
    Content: { Simple: {
      Subject: { Data: preview ? "[Migration test] Your HOA administrator sign-in link" : "Your HOA CRM sign-in link" },
      Body: { Text: { Data: `Click to sign in to HOA CRM:\n\n${link}\n\nThis link expires in 15 minutes.${preview ? " This is the migration preview; business actions remain disabled." : ""} If you did not request it, you can ignore this email.` } },
    } },
  }), { idempotencyKey: `login-request:${request.requestId}` });
}
