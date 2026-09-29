import { defineFunction } from "@aws-amplify/backend";

/** Retained function definition for compatibility; no scheduled task generation. */
export const renewalTasks = defineFunction({
  name: "renewal-tasks",
  entry: "./handler.ts",
  timeoutSeconds: 300,
  memoryMB: 512,
  resourceGroupName: "data",
});
