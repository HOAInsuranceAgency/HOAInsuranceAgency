import { defineFunction } from "@aws-amplify/backend";

/**
 * Daily licence-expiry sweep.
 *
 * Emails the agency inbox once per licence per deadline — 60 days out, 30
 * days out, and 3 days out — for firm and producer licences alike. A state
 * licence renewal is a filing with a regulator, and the failure mode is
 * silent: nothing in the CRM stops working when one lapses, the agency just
 * quietly isn't licensed where it thought it was.
 *
 * Every send is recorded as a `LicenseReminder`, so the run is idempotent: a
 * retry, a double delivery from EventBridge, or a manual re-invoke sends
 * nothing twice. That ledger is also what makes a *missed* run recoverable —
 * the rule is "is this licence inside the window", not "does it expire
 * exactly 30 days from today", so a day the job doesn't run is caught up the
 * next day rather than lost.
 *
 * 6am Eastern, an hour behind the renewal sweep so the two don't contend for
 * the same tables. Pinned to a timezone rather than UTC so it doesn't drift
 * an hour twice a year.
 */
export const licenseAlerts = defineFunction({
  name: "license-alerts",
  entry: "./handler.ts",
  schedule: {
    cron: "0 6 * * ? *",
    timezone: "America/New_York",
    description: "Daily license expiration alert",
  },
  timeoutSeconds: 300,
  memoryMB: 512,
  resourceGroupName: "data",
});
