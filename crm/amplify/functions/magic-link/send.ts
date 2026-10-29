import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { getSigningSecret, mintToken } from "./token";
import { migrationPreview } from "./migration";

const ses = new SESv2Client();

/** Called only after the destination guard and an explicit link request. */
export async function sendDestinationLink(email: string) {
  const token = mintToken(email, await getSigningSecret());
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
  }));
}
