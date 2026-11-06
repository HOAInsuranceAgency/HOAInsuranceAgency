import { defineFunction } from '@aws-amplify/backend';

export const ownerProfitability = defineFunction({
  name: 'owner-profitability', entry: './handler.sentry.ts',
  resourceGroupName: 'data', timeoutSeconds: 30, memoryMB: 512,
});
