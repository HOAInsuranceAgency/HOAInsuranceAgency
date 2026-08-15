import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import type { Schema } from "../../data/resource";
import { listAllPages } from "../../../src/lib/pagination";
import { AGENCY, AGENCY_FMT } from "../../../../shared/agency";
import { digestRows, isoDay, renderDigest } from "./digest";

/**
 * Weekday digest of outstanding marketing tasks. See resource.ts for the why.
 *
 * Read every open task → group by how close its submit-by is → one email.
 * There is no ledger and nothing is written back: this reports state, it does
 * not change any, so a retry re-sends the same snapshot and nothing is lost
 * or double-counted.
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

/**
 * The agency's own inbox, from the module that exists so the CRM and the
 * marketing site cannot disagree about the agency's address — the same
 * constant `license-alerts` sends to, rather than a second spelling typed
 * into a config. See that handler for why this is read here and not passed
 * in from `backend.ts`.
 */
const TO = `${AGENCY.name} <${AGENCY_FMT.emailLower}>`;

export const handler = async () => {
  const client = await getDataClient();
  const today = isoDay(new Date());

  // Filtered server-side so a table that grows to thousands of completed
  // tasks doesn't get paged through every morning to find the open ones.
  // `digestRows` re-checks the status anyway — the filter is an optimisation,
  // not the rule.
  const tasks = await listAllPages((nextToken) =>
    client.models.MarketingTask.list({
      filter: { status: { eq: "OPEN" } },
      nextToken,
      limit: 200,
    })
  );

  const rows = digestRows(tasks, today);

  if (rows.length === 0) {
    // Nothing outstanding, so nothing to summarise. Silence here means the
    // inbox only ever hears from this job when there is work, at the cost of
    // a quiet day being indistinguishable from a broken schedule — the same
    // trade `license-alerts` makes. The log line is what tells them apart.
    const summary = { tasksReviewed: tasks.length, sent: false };
    console.log("task-digest", JSON.stringify(summary));
    return summary;
  }

  const { subject, text, html } = renderDigest(
    rows,
    today,
    process.env.CRM_BASE_URL
  );

  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: process.env.TASK_DIGEST_FROM,
      Destination: { ToAddresses: [TO] },
      Content: {
        Simple: {
          // Charset stated on every part. The copy carries "·" and "—", and
          // without this a client is free to guess windows-1252 and render
          // them as mojibake — see the note in `renderDigest`.
          Subject: { Data: subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: text, Charset: "UTF-8" },
            Html: { Data: html, Charset: "UTF-8" },
          },
        },
      },
    })
  );

  const summary = {
    tasksReviewed: tasks.length,
    sent: true,
    open: rows.length,
    overdue: rows.filter((r) => r.bucket === "overdue").length,
    subject,
  };
  console.log("task-digest", JSON.stringify(summary));
  return summary;
};
