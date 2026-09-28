import { defineFunction } from "@aws-amplify/backend";

export const marketingReportApi = defineFunction({ name: "marketing-report-api", entry: "./api.ts", timeoutSeconds: 30, resourceGroupName: "data" });
// Collection and workbook generation run outside AppSync's 30-second limit.
export const marketingReportWorker = defineFunction({ name: "marketing-report-worker", entry: "./worker.ts", timeoutSeconds: 300, memoryMB: 1024, resourceGroupName: "marketing-report" });
