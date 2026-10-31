import { defineFunction } from "@aws-amplify/backend";

/** Receives only signed email feedback; it has no email-sending permissions. */
export const mailFeedback = defineFunction({
  name: "mail-feedback",
  entry: "./handler.ts",
  timeoutSeconds: 20,
  memoryMB: 256,
  resourceGroupName: "transactional-mail",
});
