import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { backfillApprovedPayroll } from '../amplify/functions/commissions/approved-payroll-backfill';

const { values } = parseArgs({ options: {
  table: { type: 'string' }, region: { type: 'string' }, apply: { type: 'boolean', default: false },
} });
if (!values.table || !values.region) throw new Error('Supply the verified ledger --table and --region. Use --apply to write approval references.');
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: values.region, maxAttempts: 5 }));
console.log(JSON.stringify(await backfillApprovedPayroll(db, values.table, values.apply)));
