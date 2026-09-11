import { defineFunction } from "@aws-amplify/backend";
export const communications = defineFunction({ name: "communications", entry: "./handler.ts", timeoutSeconds: 30, resourceGroupName: "data" });
export const communicationWorker = defineFunction({ name: "communication-worker", entry: "./worker.ts", timeoutSeconds: 120, memoryMB: 512, resourceGroupName: "data",
  schedule: { cron: "* * * * ? *", timezone: "America/New_York", description: "Communication delivery, reconciliation and lead deadlines" } });
export const communicationWebhook = defineFunction({ name: "communication-webhook", entry: "./webhook.ts", timeoutSeconds: 10, resourceGroupName: "data" });

export const communicationReports = defineFunction({ name: "communication-reports", entry: "./reports.ts", timeoutSeconds: 120, memoryMB: 1024, resourceGroupName: "data",
  schedule: { cron: "0-14 9 ? * 2-6 *", timezone: "America/New_York", description: "Morning team editions and delivery confirmation" } });
export const communicationMonitor = defineFunction({ name: "communication-monitor", entry: "./monitor.ts", timeoutSeconds: 30, resourceGroupName: "data",
  schedule: { cron: "0/5 * * * ? *", timezone: "America/New_York", description: "Independent communication and report coverage monitor" } });
