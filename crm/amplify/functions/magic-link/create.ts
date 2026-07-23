import type { CreateAuthChallengeTriggerHandler } from "aws-lambda";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { getSigningSecret, mintToken } from "./token";

const ses = new SESv2Client();

/**
 * mode="request" (default): mint a signed token and email the sign-in link.
 * mode="consume": the user arrived via the link in a fresh session — no
 * email; verification happens against the token they carry.
 */
export const handler: CreateAuthChallengeTriggerHandler = async (event) => {
  const mode = event.request.clientMetadata?.mode === "consume" ? "consume" : "request";
  const email = event.request.userAttributes.email;

  event.response.challengeMetadata = "MAGIC_LINK";
  event.response.publicChallengeParameters = { email, mode };
  event.response.privateChallengeParameters = { mode };

  if (mode === "request" && email) {
    const token = mintToken(email, await getSigningSecret());
    const link = `${process.env.MAGIC_LINK_BASE_URL}/#magic=${encodeURIComponent(token)}`;

    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: process.env.MAGIC_LINK_FROM,
        Destination: { ToAddresses: [email] },
        Content: {
          Simple: {
            Subject: { Data: "Your HOA CRM sign-in link" },
            Body: {
              Text: {
                Data: `Click to sign in to HOA CRM:\n\n${link}\n\nThis link expires in 15 minutes. If you didn't request it, you can ignore this email.`,
              },
              Html: {
                Data: `
<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">
  <h2 style="color:#142a4c">HOA CRM</h2>
  <p>Click the button below to sign in. No password needed.</p>
  <p style="margin:28px 0">
    <a href="${link}" style="background:#2e7dd1;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:600">Sign in to HOA CRM</a>
  </p>
  <p style="color:#64748b;font-size:13px">This link expires in 15 minutes and works once.
  If you didn't request it, you can safely ignore this email.</p>
</div>`,
              },
            },
          },
        },
      })
    );
    console.log(`Magic link sent to ${email}`);
  }

  return event;
};
