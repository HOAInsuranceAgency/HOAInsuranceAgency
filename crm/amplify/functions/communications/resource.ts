import { defineFunction } from "@aws-amplify/backend";
export const communications = defineFunction({ name: "communications", entry: "./handler.ts", timeoutSeconds: 30, resourceGroupName: "data" });
export const communicationWorker = defineFunction({ name: "communication-worker", entry: "./worker.ts", timeoutSeconds: 120, memoryMB: 512, resourceGroupName: "data",
  schedule: { cron: "* * * * ? *", timezone: "America/New_York", description: "Communication delivery, reconciliation and lead deadlines" } });
export const communicationWebhook = defineFunction({ name: "communication-webhook", entry: "./webhook.ts", timeoutSeconds: 10, resourceGroupName: "data" });
