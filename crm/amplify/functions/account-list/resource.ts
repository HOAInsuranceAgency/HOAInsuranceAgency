import { defineFunction } from '@aws-amplify/backend';
export const accountListWorker = defineFunction({ name: 'account-list-worker', entry: './handler.sentry.ts', timeoutSeconds: 120, memoryMB: 512, resourceGroupName: 'account-list',
  schedule: { cron: '* * * * ? *', timezone: 'America/New_York', description: 'Build and reconcile the private CRM account list with restartable checkpoints' } });
