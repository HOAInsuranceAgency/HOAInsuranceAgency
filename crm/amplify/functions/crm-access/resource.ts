import { defineFunction } from "@aws-amplify/backend";
export const crmAccess = defineFunction({ name: "crm-access", entry: "./handler.ts", timeoutSeconds: 30, memoryMB: 512, resourceGroupName: "data" });
