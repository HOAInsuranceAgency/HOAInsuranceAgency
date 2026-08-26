import { defineFunction, secret } from "@aws-amplify/backend";

/**
 * Dialpad's callback: every call, text and voicemail, as it happens.
 *
 * Reached at a Lambda Function URL rather than through AppSync, for the same
 * reason `stripe-webhook` is: the sender posts a signed body, which is not a
 * shape a GraphQL mutation can take.
 *
 * The URL is unauthenticated at the AWS layer, deliberately — Dialpad cannot
 * sign SigV4. The signature check IS the authentication, and it happens
 * before the body is parsed. Nothing else in the handler runs until it passes.
 *
 * ── Where this differs from the Stripe endpoint ────────────────────────
 * Stripe posts JSON with a signature in a header. Dialpad posts a JWT: the
 * body IS the token, signed HS256 with a secret shared when the subscription
 * is created. That puts the signature and the attacker-controlled payload in
 * one string, and makes an unpinned verifier a public write endpoint. See
 * ./jwt.ts, which pins the algorithm rather than reading it.
 *
 * Not scheduled, and fast: verify, resolve, upsert. One call arrives as five
 * to seven of these, so the work per invocation is deliberately small.
 */
export const dialpadWebhook = defineFunction({
  name: "dialpad-webhook",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  memoryMB: 512,
  resourceGroupName: "data",
  environment: {
    // Chosen by us and handed to Dialpad when the subscription is created —
    // unlike Stripe's, which they generate and show once.
    DIALPAD_WEBHOOK_SECRET: secret("DIALPAD_WEBHOOK_SECRET"),
  },
});
