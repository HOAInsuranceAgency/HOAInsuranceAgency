import { defineFunction } from "@aws-amplify/backend";

/** Remains installed when Google is disabled to enforce admin-only signup. */
export const googleSignIn = defineFunction({
  name: "google-sign-in",
  entry: "./handler.sentry.ts",
  resourceGroupName: "auth",
  timeoutSeconds: 5,
});
