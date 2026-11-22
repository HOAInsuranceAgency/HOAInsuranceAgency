/** Derived lookup maintenance only. Dry run by default; never modifies financial source records. */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { backfillStatementIndexes } from '../amplify/functions/commissions/statement-backfill';
const args=process.argv.slice(2);
if(args.some(a=>a.startsWith('--')&&!['--table','--region','--apply'].includes(a))) throw new Error('Use --table <reviewed ledger table> --region <region> [--apply].');
const table=args[args.indexOf('--table')+1], region=args[args.indexOf('--region')+1];
if(!args.includes('--table')||!args.includes('--region')||!table||table.startsWith('--')||!region||region.startsWith('--')) throw new Error('Explicit --table and --region are required. Dry run unless --apply is supplied.');
const client=DynamoDBDocumentClient.from(new DynamoDBClient({region,maxAttempts:5}),{marshallOptions:{removeUndefinedValues:true}});
console.log(JSON.stringify(await backfillStatementIndexes(client,table,args.includes('--apply'))));
