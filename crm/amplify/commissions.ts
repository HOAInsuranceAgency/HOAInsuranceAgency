import { Stack, RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table, TableEncryption } from 'aws-cdk-lib/aws-dynamodb';
import { Bucket, BucketEncryption, BlockPublicAccess, HttpMethods } from 'aws-cdk-lib/aws-s3';
import { PolicyStatement, type Policy } from 'aws-cdk-lib/aws-iam';
import type { Table as DynamoTable } from 'aws-cdk-lib/aws-dynamodb';
import type { backend as Backend } from './backend';
export function installCommissions(backend: typeof Backend, communicationTable: DynamoTable, accessPolicy: Policy) {
  const stack = backend.createStack('ProducerCommissions');
  const table = new Table(stack, 'CommissionLedger', {
    partitionKey: { name: 'kind', type: AttributeType.STRING },
    sortKey: { name: 'id', type: AttributeType.STRING },
    billingMode: BillingMode.PAY_PER_REQUEST,
    encryption: TableEncryption.AWS_MANAGED,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: RemovalPolicy.RETAIN,
  });
  table.addGlobalSecondaryIndex({
    indexName: 'producer',
    partitionKey: { name: 'producerId', type: AttributeType.STRING },
    sortKey: { name: 'id', type: AttributeType.STRING },
  });
  const bucket = new Bucket(stack, 'PrivateStatements', {
    encryption: BucketEncryption.S3_MANAGED,
    blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    versioned: true,
    removalPolicy: RemovalPolicy.RETAIN,
    cors: [
      {
        allowedOrigins: ['*'],
        allowedMethods: [HttpMethods.PUT, HttpMethods.GET],
        allowedHeaders: ['*'],
        exposedHeaders: ['ETag'],
      },
    ],
  });
  const fn = backend.commissions,
    api = backend.data.resources.graphqlApi;
  fn.addEnvironment('COMMISSION_TABLE', table.tableName);
  table.grantReadWriteData(fn.resources.lambda);
  fn.addEnvironment('COMMISSION_BUCKET', bucket.bucketName);
  bucket.grantReadWrite(fn.resources.lambda);
  fn.addEnvironment('ACCESS_API_ID', api.apiId);
  fn.addEnvironment('COMMUNICATION_TABLE', communicationTable.tableName);
  communicationTable.grantReadData(fn.resources.lambda);
  const modelArn = (model: string) => Stack.of(api).formatArn({ service: 'dynamodb', resource: 'table', resourceName: `${model}-${api.apiId}-NONE` });
  // Keep model grants on the same external policy as bind completion. The
  // existing role/default policy still owns its ledger, S3 and other grants.
  accessPolicy.addStatements(new PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:ConditionCheckItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
    resources: ['Account', 'Quote', 'Policy'].map(modelArn),
  }));
  accessPolicy.addStatements(new PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:ConditionCheckItem'], resources: [modelArn('Carrier')],
  }));
  accessPolicy.addStatements(new PolicyStatement({ actions: ['dynamodb:Query'], resources: [`${modelArn('Policy')}/index/*`] }));
  accessPolicy.addStatements(
    new PolicyStatement({
      actions: ['dynamodb:ConditionCheckItem'],
      resources: [communicationTable.tableArn],
    }),
  );
  return { table, bucket };
}
