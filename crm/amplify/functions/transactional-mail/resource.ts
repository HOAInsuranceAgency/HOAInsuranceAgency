import { defineFunction } from "@aws-amplify/backend";
export const mailVerification = defineFunction({ name: "mail-verification", entry: "./verification.sentry.ts", resourceGroupName: "transactional-mail", timeoutSeconds: 20, memoryMB: 512 });

export const mailRecovery = defineFunction({ name: "mail-recovery", entry: "./recovery.sentry.ts", resourceGroupName: "transactional-mail", timeoutSeconds: 30, memoryMB: 512 });
