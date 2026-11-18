import { defineFunction } from '@aws-amplify/backend';
export const commissions = defineFunction({
  name: 'commissions',
  entry: './handler.sentry.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 60,
  memoryMB: 512,
});
export const commissionPayrollWorker = defineFunction({
  name: 'commission-payroll-worker', entry: './payroll-worker.sentry.ts',
  resourceGroupName: 'commission-payroll', timeoutSeconds: 180, memoryMB: 512,
});
