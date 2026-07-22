import { defineFunction } from "@aws-amplify/backend";

/**
 * Admin team management: handles the ADMIN-only `inviteUser` mutation and
 * `listTeamUsers` query (one handler, switched on fieldName).
 */
export const teamAdmin = defineFunction({
  name: "team-admin",
  entry: "./handler.ts",
  timeoutSeconds: 30,
});
