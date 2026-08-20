import { defineFunction } from "@aws-amplify/backend";

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
});
