import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import type { Schema } from "../../data/resource";
import { listAllPages } from "../../../src/lib/pagination";
import { dueReminders, isoDay, renderDigest } from "./digest";

/**
 * Daily licence-expiry sweep. See resource.ts for the why.
 *
 * Read every licence → work out what is owed today → drop what the ledger
 * says was already sent → one digest email → record what was sent.
 *
 * The ledger is written **after** the email, and only after a send that
 * didn't throw. Written first, a failing SES call would burn the reminder:
 * the row would say the agency had been told, and the licence would never be
 * mentioned again. In the other order the worst case is a duplicate email
 * after a partial failure, which is a nuisance rather than a missed renewal.
 */

let dataClient: ReturnType<typeof generateClient<Schema>> | undefined;
async function getDataClient() {
  if (!dataClient) {
    const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(
      process.env as never
    );
    Amplify.configure(resourceConfig, libraryOptions);
    dataClient = generateClient<Schema>();
  }
  return dataClient;
}

const ses = new SESv2Client();

export const handler = async () => {
  const client = await getDataClient();
  const today = isoDay(new Date());

  const [licenses, sent] = await Promise.all([
    // `.list()` caps at 100 — a sweep that stopped at the first page would
    // silently go quiet for the newest licences as the table grows.
    listAllPages((nextToken) =>
      client.models.License.list({ nextToken, limit: 200 })
    ),
    listAllPages((nextToken) =>
      client.models.LicenseReminder.list({ nextToken, limit: 200 })
    ),
  ]);

  const alreadySent = new Set(sent.map((r) => r.dedupeKey));
  const due = dueReminders(licenses, today).filter(
    (r) => !alreadySent.has(r.dedupeKey)
  );

  if (due.length === 0) {
    const summary = { licensesReviewed: licenses.length, remindersSent: 0 };
    console.log("license-alerts sweep", JSON.stringify(summary));
    return summary;
  }

  const { subject, text, html } = renderDigest(due);
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: process.env.LICENSE_ALERT_FROM,
      Destination: { ToAddresses: [process.env.LICENSE_ALERT_TO as string] },
      Content: {
        Simple: {
          Subject: { Data: subject },
          Body: { Text: { Data: text }, Html: { Data: html } },
        },
      },
    })
  );

  const sentAt = new Date().toISOString();
  let recorded = 0;
  for (const r of due) {
    const { errors } = await client.models.LicenseReminder.create({
      licenseId: r.licenseId,
      dedupeKey: r.dedupeKey,
      threshold: r.threshold,
      expirationDate: r.expirationDate,
      sentAt,
    });
    if (!errors?.length) {
      recorded++;
    } else {
      // The email is already out. A ledger row that failed to write means
      // tomorrow's run repeats that licence — logged loudly because the
      // symptom (a daily repeat of one line) otherwise looks like a bug in
      // the reminder rule rather than a write that didn't land.
      console.error(
        "LicenseReminder create failed",
        r.dedupeKey,
        errors[0].message
      );
    }
  }

  const summary = {
    licensesReviewed: licenses.length,
    remindersSent: due.length,
    remindersRecorded: recorded,
    subject,
  };
  console.log("license-alerts sweep", JSON.stringify(summary));
  return summary;
};
