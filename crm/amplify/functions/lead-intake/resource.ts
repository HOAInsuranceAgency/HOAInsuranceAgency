import { defineFunction } from "@aws-amplify/backend";

/**
 * Handler for the public `submitWebLead` mutation — creates LEAD accounts
 * from protectmyhoa.com form submissions.
 */
export const leadIntake = defineFunction({
  name: "lead-intake",
  entry: "./handler.ts",
  timeoutSeconds: 30,
});
