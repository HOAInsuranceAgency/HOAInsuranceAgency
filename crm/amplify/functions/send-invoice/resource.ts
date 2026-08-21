import { defineFunction, secret } from "@aws-amplify/backend";

/**
 * Emails an invoice to the insured, with a payment link.
 *
 * Authenticated-only: a producer presses Send on the policy page. Nothing about
 * this is public and no token gates it, unlike the lead-facing functions.
 *
 * It reads the invoice and its lines server-side rather than taking amounts
 * from the caller. The browser has already computed the same totals for the
 * screen, but an emailed invoice is a demand for money and the figure in it
 * should come from the rows in the database, not from whatever a client posted.
 */
export const sendInvoice = defineFunction({
  name: "send-invoice",
  entry: "./handler.ts",
  timeoutSeconds: 60,
  memoryMB: 512,
  resourceGroupName: "data",
  environment: {
    /**
     * Mints the ACH payment link that goes in the email.
     *
     * Declared here rather than in backend.ts, as `lead-reply` declares its
     * own: `secret()` resolves per branch, so staging signs with a test key and
     * main with a live one and neither this file nor backend.ts needs to know
     * which. Unset, the invoice still sends — with no Pay button.
     */
    STRIPE_SECRET_KEY: secret("STRIPE_SECRET_KEY"),
  },
});
