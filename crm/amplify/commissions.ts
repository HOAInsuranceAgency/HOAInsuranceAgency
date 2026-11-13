import { Stack, RemovalPolicy, Duration, Names, TimeZone } from 'aws-cdk-lib';
import { Schedule, ScheduleExpression, ScheduleTargetInput, ContextAttribute } from 'aws-cdk-lib/aws-scheduler';
import { LambdaInvoke } from 'aws-cdk-lib/aws-scheduler-targets';
import { Alarm, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { CfnFunction } from 'aws-cdk-lib/aws-lambda';
import { businessBranch, migrationExecution } from './migration-config';
import { AttributeType, BillingMode, Table, TableEncryption } from 'aws-cdk-lib/aws-dynamodb';
import { Bucket, BucketEncryption, BlockPublicAccess, HttpMethods } from 'aws-cdk-lib/aws-s3';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { Table as DynamoTable } from 'aws-cdk-lib/aws-dynamodb';
import type { backend as Backend } from './backend';
export function installCommissions(backend: typeof Backend, communicationTable: DynamoTable, alerts: ITopic, sender: string, crmUrl: string) {
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
  fn.addEnvironment('COMMISSION_PAYROLL_ENV', businessBranch || 'local');
  fn.addEnvironment('COMMISSION_BUCKET', bucket.bucketName);
  bucket.grantReadWrite(fn.resources.lambda);
  // Textract analysis APIs do not support resource-level IAM. Sources stay in the private bucket.
  fn.resources.lambda.addToRolePolicy(new PolicyStatement({ actions: ['textract:StartDocumentAnalysis', 'textract:GetDocumentAnalysis'], resources: ['*'] }));
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
  const worker = backend.commissionPayrollWorker;
  const workerStack = Stack.of(worker.resources.lambda);
  worker.addEnvironment('COMMISSION_TABLE', table.tableName);
  worker.addEnvironment('COMMISSION_PAYROLL_ENV', businessBranch || 'local');
  worker.addEnvironment('COMMISSION_PAYROLL_FROM', sender);
  worker.addEnvironment('COMMISSION_PAYROLL_URL', crmUrl);
  worker.addEnvironment('USER_POOL_ID', backend.auth.resources.userPool.userPoolId);
  worker.resources.lambda.addToRolePolicy(new PolicyStatement({ actions: ['cognito-idp:ListUsersInGroup'], resources: [backend.auth.resources.userPool.userPoolArn] }));
  worker.addEnvironment('HOA_MIGRATION_BUSINESS_HELD', String(migrationExecution.holdBusinessExecution));
  // The scheduler can inspect approved payroll and record delivery only. It
  // cannot alter policies, earnings, plans, source statements or payroll batches.
  worker.resources.lambda.addToRolePolicy(new PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:BatchGetItem', 'dynamodb:ConditionCheckItem'], resources: [table.tableArn],
    conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['PAYROLL_SETTINGS', 'PAYROLL_CYCLE', 'PAYROLL_DELIVERY', 'PAYROLL_REPORT', 'PAYROLL_REPORT_FILE', 'BATCH'] } },
  }));
  worker.resources.lambda.addToRolePolicy(new PolicyStatement({
    actions: ['dynamodb:PutItem'], resources: [table.tableArn],
    conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['PAYROLL_DELIVERY', 'AUDIT'] } },
  }));
  const scheduleName = `commission-payroll-${Names.uniqueId(backend.stack).slice(-40)}`;
  worker.addEnvironment('COMMISSION_PAYROLL_SCHEDULE_ARN', workerStack.formatArn({ service: 'scheduler', resource: 'schedule', resourceName: `default/${scheduleName}` }));
  const failed = new Queue(workerStack, 'PayrollScheduleFailures', { encryption: QueueEncryption.SQS_MANAGED, retentionPeriod: Duration.days(14) });
  new Schedule(workerStack, 'CommissionPayrollSchedule', {
    scheduleName, enabled: businessBranch === 'main' && !migrationExecution.holdBusinessExecution,
    description: 'Check approved commission payroll and review deadlines hourly, 8 AM to 5 PM Eastern. Delivery defaults off in settings.',
    schedule: ScheduleExpression.cron({ minute: '0', hour: '8-17', timeZone: TimeZone.AMERICA_NEW_YORK }),
    target: new LambdaInvoke(worker.resources.lambda, { retryAttempts: 2, maxEventAge: Duration.hours(1), deadLetterQueue: failed, input: ScheduleTargetInput.fromObject({ trigger: 'scheduled', scheduleArn: ContextAttribute.scheduleArn, scheduledAt: ContextAttribute.scheduledTime }) }),
  });
  (worker.resources.lambda.node.defaultChild as CfnFunction).reservedConcurrentExecutions = 1;
  worker.resources.lambda.configureAsyncInvoke({ retryAttempts: 0, maxEventAge: Duration.minutes(5) });
  for (const [name, metric] of [
    ['PayrollDeliveryErrors', worker.resources.lambda.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' })],
    ['PayrollScheduleErrors', failed.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5), statistic: 'Maximum' })],
  ] as const) {
    const alarm = new Alarm(workerStack, name, { metric, threshold: 1, evaluationPeriods: 1, treatMissingData: TreatMissingData.NOT_BREACHING, alarmDescription: 'Commission payroll reporting requires review. Check the payroll workspace and mail ledger before retrying.' });
    alarm.addAlarmAction(new SnsAction(alerts));
  }
  return { table, bucket };
}
