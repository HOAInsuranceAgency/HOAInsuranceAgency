import { Duration, Stack } from 'aws-cdk-lib';
import { AttributeType, BillingMode, StreamViewType, Table, TableEncryption } from 'aws-cdk-lib/aws-dynamodb';
import { ManagedPolicy, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { CfnFunction, StartingPosition } from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { modelIndex } from './model-index';
import type { backend as Backend } from './backend';

/** This table is not an Amplify model and has no client IAM/AppSync access.
 * The reader queries its own scoped partitions and revalidates source versions
 * and current assignment before returning materialized account data. */
export function installAccountList(backend: typeof Backend, communicationTable: Table) {
  const api = backend.data.resources.graphqlApi;
  const table = new Table(api, 'AccountListRecords', {
    partitionKey: { name: 'pk', type: AttributeType.STRING }, sortKey: { name: 'sk', type: AttributeType.STRING },
    billingMode: BillingMode.PAY_PER_REQUEST, encryption: TableEncryption.AWS_MANAGED,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
  });
  const worker = backend.accountListWorker, reader = backend.communications;
  table.grantReadWriteData(worker.resources.lambda);
  // Keep additive read grants outside the busy communications role's inline
  // budget and the generated data template. The policy attaches to the role,
  // rather than adding a reverse dependency from that role to this stack.
  const readerPolicy = new ManagedPolicy(backend.createStack('AccountListReadPermissions'), 'AccountListReadAccess', { roles: [reader.resources.lambda.role!] });
  readerPolicy.addStatements(new PolicyStatement({ actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:BatchGetItem'], resources: [table.tableArn] }));
  const sourceTables: Record<string, string> = { Communication: communicationTable.tableName };
  const indexes: Record<string, string> = {};
  const sourceModels = ['Account', 'Contact', 'Quote', 'Policy', 'UserProfile'] as const;
  for (const model of sourceModels) {
    // API-derived names avoid a generated model-resolver -> Lambda -> table
    // nested-stack cycle, following the account-access installer.
    const name = `${model}-${api.apiId}-NONE`;
    sourceTables[model] = name;
    if (model !== 'Account') indexes[model] = modelIndex(api, model, model === 'UserProfile' ? 'userId' : 'accountId').name;
    const resource = Stack.of(api).formatArn({ service: 'dynamodb', resource: 'table', resourceName: name });
    worker.resources.lambda.addToRolePolicy(new PolicyStatement({ actions: ['dynamodb:GetItem', 'dynamodb:BatchGetItem', ...(model === 'Account' ? ['dynamodb:Scan'] : [])], resources: [resource] }));
    readerPolicy.addStatements(new PolicyStatement({ actions: ['dynamodb:BatchGetItem'], resources: [resource] }));
    if (indexes[model]) worker.resources.lambda.addToRolePolicy(new PolicyStatement({ actions: ['dynamodb:Query'], resources: [`${resource}/index/${indexes[model]}`] }));
    backend.data.resources.cfnResources.amplifyDynamoDbTables[model].streamSpecification = { streamViewType: StreamViewType.NEW_AND_OLD_IMAGES };
    worker.resources.lambda.addEventSource(new DynamoEventSource(backend.data.resources.tables[model], {
      startingPosition: StartingPosition.LATEST, batchSize: 25, maxBatchingWindow: Duration.seconds(1), retryAttempts: 10,
      maxRecordAge: Duration.hours(2), reportBatchItemFailures: true,
    }));
  }
  communicationTable.grantReadData(worker.resources.lambda);
  communicationTable.grantReadData(readerPolicy);
  worker.resources.lambda.addEventSource(new DynamoEventSource(communicationTable, {
    startingPosition: StartingPosition.LATEST, batchSize: 25, maxBatchingWindow: Duration.seconds(1), retryAttempts: 10,
    maxRecordAge: Duration.hours(2), reportBatchItemFailures: true,
  }));
  worker.addEnvironment('ACCOUNT_LIST_SOURCE_INDEXES', JSON.stringify(indexes));
  worker.addEnvironment('ACCOUNT_LIST_SOURCE_TABLES', JSON.stringify(sourceTables));
  for (const fn of [worker, reader]) {
    fn.addEnvironment('ACCOUNT_LIST_TABLE', table.tableName);
  }
  // Scheduled sweeps and all source streams share one owner. Source writes
  // remain concurrent; the endpoint's dependency fences reject outdated rows.
  (worker.resources.lambda.node.defaultChild as CfnFunction).reservedConcurrentExecutions = 1;
  backend.addOutput({ custom: { accountList: { tableName: table.tableName, version: '1' } } });
  return table;
}
