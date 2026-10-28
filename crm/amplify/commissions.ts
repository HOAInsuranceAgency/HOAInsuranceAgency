import { Stack, RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table, TableEncryption } from 'aws-cdk-lib/aws-dynamodb';
import { Bucket, BucketEncryption, BlockPublicAccess, HttpMethods } from 'aws-cdk-lib/aws-s3';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { Table as DynamoTable } from 'aws-cdk-lib/aws-dynamodb';
import type { backend as Backend } from './backend';
export function installCommissions(backend: typeof Backend, communicationTable: DynamoTable) {
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
  for (const model of ['Account', 'Quote', 'Policy', 'Carrier']) {
    const name = `${model}-${api.apiId}-NONE`,
      arn = Stack.of(api).formatArn({ service: 'dynamodb', resource: 'table', resourceName: name });
    fn.resources.lambda.addToRolePolicy(
      new PolicyStatement({
        actions: [
          'dynamodb:GetItem',
          'dynamodb:ConditionCheckItem',
          ...(model === 'Carrier' ? [] : ['dynamodb:PutItem', 'dynamodb:UpdateItem']),
        ],
        resources: [arn],
      }),
    );
    if (model === 'Policy')
      fn.resources.lambda.addToRolePolicy(
        new PolicyStatement({ actions: ['dynamodb:Query'], resources: [`${arn}/index/*`] }),
      );
  }
  fn.resources.lambda.addToRolePolicy(
    new PolicyStatement({
      actions: ['dynamodb:ConditionCheckItem'],
      resources: [communicationTable.tableArn],
    }),
  );
}
