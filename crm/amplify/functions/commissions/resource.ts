import { defineFunction } from '@aws-amplify/backend';
export const commissions = defineFunction({
  name: 'commissions',
  entry: './handler.sentry.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 60,
  memoryMB: 512,
});
