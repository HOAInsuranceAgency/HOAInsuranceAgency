import { migrationPreview } from '../../migration-config';
import { defineFunction, secret } from '@aws-amplify/backend';
export const brokerFees = defineFunction({ name: 'broker-fees', entry: './handler.ts', timeoutSeconds: 30, memoryMB: 512, resourceGroupName: 'data', environment: migrationPreview ? {} : {STRIPE_SECRET_KEY: secret('STRIPE_SECRET_KEY')} });
