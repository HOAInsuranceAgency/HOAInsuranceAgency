import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import type { Schema } from "../../data/resource";
import { listAllPages } from "../../../src/lib/pagination";
import { buildFindings } from "./detect";
import { buildDone } from "./done";
import { buildProgress } from "./progress";
import { writeRead } from "./read";
import { renderRollup } from "./render";
import { addDays, editionFor, etMidnight } from "./window";

/**
 * Read → detect → render → send. See `resource.ts` for the why, `detect.ts`
 * for what counts as a miss, and `window.ts` for which slice of time this
 * edition speaks for.
 *
 * Nothing is written back. This reports state and changes none, so a retry
 * re-sends the same picture and nothing is double-counted — the same property
 * `task-digest` relies on, and here it is a requirement rather than a
 * convenience (see `resource.ts` on why no ledger may exist).
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
 * How far back the Activity scan reaches.
 *
 * Wider than any edition's window, because the per-person trailing figure and
 * the Monday quiet-producer line both need more than a day of history to mean
 * anything. Fourteen days is two working weeks — enough for the trailing
 * number to be stable, short enough that the scan stays cheap.
 */
const ACTIVITY_SCAN_DAYS = 14;

/**
 * Pages of Activity to read before giving up.
 *
 * `Activity`'s only index is `entityId + occurredAt`, so an agency-wide read
 * by time is a filtered table scan — correct at today's volume, and linear in
 * a table that grows with every write and has no TTL. The cap is a backstop
 * against a slow morning turning into a timeout, and hitting it is REPORTED in
 * the email rather than swallowed: a rollup that quietly under-counts is worse
 * than one that says it under-counted. If this starts firing, the fix is a
 * global secondary index on the table, not a bigger number here.
 */
const ACTIVITY_MAX_PAGES = 40;

export const handler = async () => {
  const client = await getDataClient();
  const now = new Date();
  const edition = editionFor(now);

  const scanFromDay = addDays(edition.todayDay, -ACTIVITY_SCAN_DAYS);
  const trailingStartMs = etMidnight(scanFromDay).getTime();

  // The kill switch, first: every premium-finance rule below is suppressed
  // when the module is dark, and reporting on loans that cannot exist would be
  // worse than reporting nothing.
  const { data: settings } = await client.models.AgencySettings.get({ id: "AGENCY" });
  const premiumFinanceEnabled = settings?.premiumFinanceEnabled === true;

  const [
    leads,
    clients,
    policies,
    quotes,
    invoices,
    tasks,
    loans,
    notices,
    loanPayments,
    certificates,
    leadReplies,
    licenses,
    carriers,
    profiles,
  ] = await Promise.all([
    listAllPages((nextToken) =>
      client.models.Account.list({ filter: { stage: { eq: "LEAD" } }, nextToken })
    ),
    listAllPages((nextToken) =>
      client.models.Account.list({ filter: { stage: { eq: "CLIENT" } }, nextToken })
    ),
    listAllPages((nextToken) => client.models.Policy.list({ nextToken })),
    listAllPages((nextToken) => client.models.Quote.list({ nextToken })),
    listAllPages((nextToken) => client.models.Invoice.list({ nextToken })),
    listAllPages((nextToken) =>
      client.models.MarketingTask.list({ limit: 500, nextToken })
    ),
    premiumFinanceEnabled
      ? listAllPages((nextToken) => client.models.PfLoan.list({ nextToken }))
      : Promise.resolve([]),
    premiumFinanceEnabled
      ? listAllPages((nextToken) => client.models.PfNotice.list({ nextToken }))
      : Promise.resolve([]),
    premiumFinanceEnabled
      ? listAllPages((nextToken) => client.models.PfLoanPayment.list({ nextToken }))
      : Promise.resolve([]),
    listAllPages((nextToken) => client.models.Certificate.list({ nextToken })),
    listAllPages((nextToken) => client.models.LeadReply.list({ nextToken })),
    listAllPages((nextToken) => client.models.License.list({ nextToken })),
    listAllPages((nextToken) => client.models.Carrier.list({ nextToken })),
    listAllPages((nextToken) => client.models.UserProfile.list({ nextToken })),
  ]);

  // Read inline rather than through `listAllPages` because truncation has to
  // be visible to the reader, and that helper returns rows without saying
  // whether it stopped early.
  const activity: Schema["Activity"]["type"][] = [];
  let activityTruncated = false;
  {
    let token: string | undefined;
    let pages = 0;
    do {
      const page = await client.models.Activity.list({
        filter: { occurredAt: { ge: new Date(trailingStartMs).toISOString() } },
        limit: 500,
        nextToken: token,
      });
      activity.push(...page.data);
      token = page.nextToken ?? undefined;
      pages += 1;
      if (token && pages >= ACTIVITY_MAX_PAGES) {
        activityTruncated = true;
        break;
      }
    } while (token);
  }

  const findings = buildFindings(
    {
      leads,
      clients,
      policies,
      quotes,
      invoices,
      tasks,
      loans,
      notices,
      leadReplies,
      licenses,
      premiumFinanceEnabled,
    },
    edition
  );

  const done = buildDone(
    {
      activity,
      profiles,
      policies,
      accounts: [...leads, ...clients],
      certificates,
      invoices,
      tasks,
      loanPayments,
      loans,
      carriers,
      premiumFinanceEnabled,
    },
    edition,
    trailingStartMs
  );

  const progress = buildProgress(
    {
      policies,
      quotes,
      accounts: [...leads, ...clients],
      carriers,
    },
    edition.todayDay,
    edition.windowStartDay
  );

  const visible = findings.filter((f) => f.visibility === "row");
  const exposed = visible.filter((f) => f.band === "exposed").length;

  // A weekend edition exists for the calendar-driven failures only, and stays
  // silent otherwise. On a weekday it always sends: the all-clear line IS the
  // payload, and once the mail always arrives, a missing one is itself the
  // alert (nothing in this codebase alarms on a scheduled function that
  // fails to send).
  if (!edition.sendsWhenClear && exposed === 0) {
    console.log(
      "ops-rollup",
      JSON.stringify({
        edition: edition.kind,
        activityRows: activity.length,
        findings: findings.length,
        sent: false,
      })
    );
    return { sent: false, edition: edition.kind };
  }

  /**
   * The one recipient.
   *
   * NO FALLBACK, deliberately — and this is a departure from `task-digest` and
   * `license-alerts`, which both fall back to the agency's general mailbox
   * when their variable is missing. Here that default would mail this report
   * to the entire team, which is the one outcome the design exists to prevent.
   * An unset variable aborts the run instead. Do not "fix" this back.
   */
  const to = process.env.OPS_ROLLUP_TO;
  if (!to) {
    console.error("ops-rollup: OPS_ROLLUP_TO is unset — not sending");
    return { sent: false, edition: edition.kind, error: "no-recipient" };
  }

  /**
   * The opening paragraph, written from the figures above.
   *
   * Last, and deliberately not in the `Promise.all` — it takes the computed
   * numbers as its input, and it is the one step allowed to fail without
   * costing the email. `writeRead` never throws; a null here just means the
   * rollup opens with its lists instead.
   */
  const read = await writeRead({
    covering: edition.covering,
    exposed: visible
      .filter((f) => f.band === "exposed")
      .map((f) => ({ subject: f.subject, clause: f.clause, amount: f.amount })),
    closing: visible
      .filter((f) => f.band === "closing")
      .map((f) => ({ subject: f.subject, clause: f.clause, amount: f.amount })),
    money: visible
      .filter((f) => f.band === "money")
      .map((f) => ({ subject: f.subject, clause: f.clause, amount: f.amount })),
    standingCounts: findings
      .filter((f) => f.visibility === "standing")
      .reduce<Record<string, number>>((acc, f) => {
        acc[f.kind] = (acc[f.kind] ?? 0) + 1;
        return acc;
      }, {}),
    done: { ...done.summary, people: done.people.length },
    progress: { ...progress },
  });

  const { subject, text, html } = renderRollup({
    edition,
    findings,
    done,
    progress,
    read: read.text,
    truncated: activityTruncated,
    baseUrl: process.env.CRM_BASE_URL,
  });

  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: process.env.OPS_ROLLUP_FROM,
      // Exactly one recipient, and no Bcc/Cc/Reply-To keys at all — absent
      // rather than empty, so a later addition is a visible change.
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: text, Charset: "UTF-8" },
            Html: { Data: html, Charset: "UTF-8" },
          },
        },
      },
    })
  );

  // Counts only. No recipient, no subject, no account or person names —
  // a CloudWatch log group is not a private place, and `task-digest` logging
  // its own subject line is not a precedent this one can follow.
  const summary = {
    edition: edition.kind,
    activityRows: activity.length,
    invoices: invoices.length,
    quotes: quotes.length,
    openTasks: tasks.filter((t) => t.status === "OPEN").length,
    truncated: activityTruncated,
    exposed,
    closing: visible.filter((f) => f.band === "closing").length,
    money: visible.filter((f) => f.band === "money").length,
    standing: findings.filter((f) => f.visibility === "standing").length,
    people: done.people.length,
    read: read.skipped ?? "written",
    sent: true,
  };
  console.log("ops-rollup", JSON.stringify(summary));
  return summary;
};
