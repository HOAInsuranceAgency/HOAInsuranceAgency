import { defineFunction } from "@aws-amplify/backend";

/** Topic-bound SES events only; no public endpoint or email-sending permission. */
export const sesMailFeedback = defineFunction({
  name: "ses-mail-feedback",
  entry: "./handler.sentry.ts",
  timeoutSeconds: 20,
  memoryMB: 256,
  resourceGroupName: "transactional-mail-ses",
});
