import { defineFunction } from "@aws-amplify/backend";

/**
 * Team management: Admin/Owner invitations, roles and roster reads, plus
 * Owner-only account deactivation and restoration.
 */
export const teamAdmin = defineFunction({
  name: "team-admin",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  // Data resolver that also references the user pool: living in the data
  // stack keeps the stack graph acyclic (data already depends on auth).
  resourceGroupName: "data",
});
