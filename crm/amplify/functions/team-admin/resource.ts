import { defineFunction } from "@aws-amplify/backend";

/**
 * Admin team management: handles the ADMIN-only `inviteUser` mutation and
 * `listTeamUsers` query (one handler, switched on fieldName).
 */
export const teamAdmin = defineFunction({
  name: "team-admin",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  // Data resolver that also references the user pool: living in the data
  // stack keeps the stack graph acyclic (data already depends on auth).
  resourceGroupName: "data",
});
