import { defineFunction, secret } from "@aws-amplify/backend";

/**
 * Stripe's callback: the only thing that knows when money actually arrived.
 *
 * Reached at a Lambda Function URL rather than through AppSync. Stripe posts a
 * raw body with a signature over it, which is not a shape a GraphQL mutation
 * can take — and an API-key mutation would be a public write surface secured by
 * a key in a header, where this is secured by a signature over the payload.
 *
 * The URL is unauthenticated at the AWS layer, deliberately: Stripe cannot sign
 * SigV4. The signature check IS the authentication, so it happens before the
 * body is parsed and nothing else in the handler runs until it passes.
 *
 * Not scheduled, and fast: verify, decide, one write.
 */
export const stripeWebhook = defineFunction({
  name: "stripe-webhook",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  memoryMB: 512,
  resourceGroupName: "data",
  environment: {
    STRIPE_SECRET_KEY: secret("STRIPE_SECRET_KEY"),
    // Stripe shows this once, when the endpoint is created in their dashboard.
    STRIPE_WEBHOOK_SECRET: secret("STRIPE_WEBHOOK_SECRET"),
  },
});
