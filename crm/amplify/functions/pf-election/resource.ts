import { defineFunction, secret } from "@aws-amplify/backend";

/**
 * The public finance-election endpoint: the association's side of W7.
 *
 * Its own function, like upload-portal and for the same reason — it serves
 * anonymous callers holding a token, and nothing else in the API should share
 * a role with that. Two operations ride it: `financeElectionTerms` (render
 * the offer) and `acceptFinanceElection` (void the pay-in-full link, stamp
 * the election, hand back a Stripe Checkout URL that collects the down
 * payment and saves the ACH mandate).
 *
 * The Stripe key is the ONE key — decision 5 as revised 2026-08-23: the
 * election's money settles to the premium trust on the same rail invoices
 * do. `secret()` resolves per branch, so staging elects against test mode.
 */
export const pfElection = defineFunction({
  name: "pf-election",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  environment: {
    STRIPE_SECRET_KEY: secret("STRIPE_SECRET_KEY"),
  },
  resourceGroupName: "data",
});
