import { defineFunction } from "@aws-amplify/backend";

/**
 * Weekday digest of outstanding marketing tasks.
 *
 * One email to the agency inbox each weekday morning listing every open
 * `MarketingTask`, worst deadline first. The Tasks screen already holds this,
 * but it only holds it for whoever opens it — a submission window that closes
 * on a Tuesday closes silently otherwise, and the screenshot that prompted
 * this had fifteen rows already past their submit-by.
 *
 * ── Why 07:00 ──
 * Behind both of the other scheduled jobs, deliberately. `renewal-tasks` runs
 * at 05:00 and is what *raises* tasks as risks enter their submission window;
 * `license-alerts` runs at 06:00. Running third means the digest reports the
 * list as it stands after this morning's sweep rather than yesterday's, and
 * the three never contend for the same tables.
 *
 * Pinned to a timezone rather than UTC so it doesn't drift an hour twice a
 * year and start landing at 06:00 or 08:00.
 *
 * ── Why weekdays ──
 * Carrier submissions are weekday work. A Saturday email is read on Monday
 * alongside Monday's, so it is one more thing to dismiss rather than one more
 * thing done. Nothing is lost by skipping: the digest is a snapshot of open
 * state, not a ledger of events, so Monday's covers the weekend's arrivals.
 *
 * `2-6`, NOT `MON-FRI`. EventBridge accepts the names, but Amplify validates
 * the expression itself first and its day-of-week check is a plain numeric
 * range — `Number("MON")` is NaN, the schedule is rejected, and synth dies
 * partway through asset staging with an unrelated-looking ENOENT about
 * copying `schema.graphql`. In this field 1 is Sunday, so 2-6 is Mon-Fri.
 * `npm run synth:check` is what catches it; `tsc` cannot see it at all.
 *
 * ── No dedupe ledger ──
 * Unlike `license-alerts`, which must never report the same deadline twice,
 * this is a snapshot and is *meant* to repeat until the work is done. So
 * there is nothing to record and no ledger to keep. The cost is that a
 * duplicate EventBridge delivery sends a duplicate digest — a nuisance, and
 * the alternative is a new model and a write on every run to prevent it.
 */
export const taskDigest = defineFunction({
  name: "task-digest",
  entry: "./handler.ts",
  schedule: {
    cron: "0 7 ? * 2-6 *",
    timezone: "America/New_York",
    description: "Weekday outstanding-task digest",
  },
  timeoutSeconds: 300,
  memoryMB: 512,
  resourceGroupName: "data",
});
