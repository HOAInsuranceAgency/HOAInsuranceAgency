import { defineFunction, secret } from "@aws-amplify/backend";

/**
 * Autopay: once a day, every ACTIVE loan with a mandate on file and a due
 * installment gets one off-session debit attempt for the frozen schedule
 * row's exact cents. The webhook posts the ledger row when the debit clears;
 * this function only asks Stripe to start it, and marks the loan so the
 * default sweep and a hand posting both know money is in flight.
 *
 * Runs at 06:15, half an hour BEFORE the default sweep: a loan due today is
 * debited before the sweep looks at it, and the pending marker the debit
 * leaves is what tells the sweep to stand down while ACH clears.
 */
export const pfAutopay = defineFunction({
  name: "pf-autopay",
  entry: "./handler.ts",
  environment: {
    STRIPE_SECRET_KEY: secret("STRIPE_SECRET_KEY"),
  },
  schedule: {
    // Day-of-month `*`, day-of-week `?` — see pf-default-sweep.
    cron: "15 6 * * ? *",
    timezone: "America/New_York",
    description: "Premium finance autopay debits",
  },
  timeoutSeconds: 300,
  resourceGroupName: "data",
});
