import { defineFunction } from "@aws-amplify/backend";
export const communications = defineFunction({ name: "communications", entry: "./handler.ts", timeoutSeconds: 30, resourceGroupName: "data" });
export const communicationWorker = defineFunction({ name: "communication-worker", entry: "./worker.ts", timeoutSeconds: 120, memoryMB: 512, resourceGroupName: "data",
  schedule: { cron: "* * * * ? *", timezone: "America/New_York", description: "Communication delivery and provider reconciliation" } });
export const communicationWebhook = defineFunction({ name: "communication-webhook", entry: "./webhook.ts", timeoutSeconds: 10, resourceGroupName: "data" });

/** Retired compatibility definition. Daily staff reports are no longer scheduled. */
export const communicationReports = defineFunction({ name: "communication-reports", entry: "./reports.ts", resourceGroupName: "data" });
export const communicationMonitor = defineFunction({ name: "communication-monitor", entry: "./monitor.ts", timeoutSeconds: 30, resourceGroupName: "data",
  schedule: { cron: "0/5 * * * ? *", timezone: "America/New_York", description: "Independent communication processing monitor" } });

// Backfill is independent of provider configuration and the delivery worker.
export const assignmentIndexWorker = defineFunction({ name: "assignment-index-worker", entry: "./assignmentIndex.ts", timeoutSeconds: 60, memoryMB: 512, resourceGroupName: "data",
  schedule: { cron: "* * * * ? *", timezone: "America/New_York", description: "Drain assignment index backfill with restartable checkpoints" } });
