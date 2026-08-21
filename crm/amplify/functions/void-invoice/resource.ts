import { defineFunction, secret } from "@aws-amplify/backend";

/**
 * Retiring an invoice, and the payment link that came with it.
 *
 * ## Why this is not a status change in the browser
 *
 * It was, and that left money collectable on a bill the agency had withdrawn.
 * Voiding set `status` and nothing else, so the Stripe Payment Link stayed
 * active: an association working from the original email could still pay it,
 * and the webhook — which skips every event for a void invoice, correctly, so
 * that a void is not silently undone — would record none of it. Funds in the
 * trust account, no invoice they belong to, and nothing anywhere saying so.
 *
 * Deactivating the link needs the Stripe secret, which cannot go near a
 * browser. So the void moves server-side in one step: kill the link first, then
 * write the status, so a failure leaves a live invoice with a live link rather
 * than a dead invoice someone can still pay.
 */
export const voidInvoice = defineFunction({
  name: "void-invoice",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  resourceGroupName: "data",
  environment: {
    STRIPE_SECRET_KEY: secret("STRIPE_SECRET_KEY"),
  },
});
