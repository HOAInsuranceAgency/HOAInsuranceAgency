import { defineFunction } from "@aws-amplify/backend";

/**
 * Default detection: once a day, any ACTIVE loan whose next due date has
 * passed without a posting becomes DEFAULTED, with a compliance-log row.
 *
 * Daily is the right cadence for money due monthly — a minutely sweep would
 * be noise, and the notice sequence that follows runs on a 15-day clock.
 * Marking only; the notice sequence is a human's deliberate act, because
 * mailing a cancellation threat is not something a cron should do unattended.
 */
export const pfDefaultSweep = defineFunction({
  name: "pf-default-sweep",
  entry: "./handler.ts",
  schedule: {
    // Day-of-month `*`, day-of-week `?` — the one combination Amplify's
    // validator accepts (see task-digest for the failure mode).
    cron: "45 6 * * ? *",
    timezone: "America/New_York",
    description: "Premium finance default detection",
  },
  timeoutSeconds: 300,
  resourceGroupName: "data",
});
