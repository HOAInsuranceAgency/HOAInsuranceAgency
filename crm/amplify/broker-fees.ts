import { RemovalPolicy, Stack, Duration } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table, TableEncryption, type Table as DynamoTable } from 'aws-cdk-lib/aws-dynamodb';
import { Policy, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import type { backend as Backend } from './backend';

/** Server-owned consent and receipts; financial and public signing APIs share no browser write grant. */
export function installBrokerFees(backend: typeof Backend, communicationTable: DynamoTable, commissionTable: DynamoTable, siteUrl: string) {
  const stack = backend.createStack('BrokerFees');
  const fees = new Table(stack, 'BrokerFeeLedger', {
    partitionKey: { name: 'id', type: AttributeType.STRING },
    billingMode: BillingMode.PAY_PER_REQUEST, encryption: TableEncryption.AWS_MANAGED,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }, removalPolicy: RemovalPolicy.RETAIN,
  });
  for (const [indexName, field] of [['kind','kind'],['pending','pending'],['account','accountId']] as const) {
    fees.addGlobalSecondaryIndex({ indexName, partitionKey: { name: field, type: AttributeType.STRING }, sortKey: { name: 'id', type: AttributeType.STRING } });
  }
  // Keep IAM attachments outside the nearly-full generated data template.
  // This stack depends on the roles/tables; neither depends on these policies.
  const permissions = backend.createStack('BrokerFeePermissions');
  const api = backend.data.resources.graphqlApi;
  const writers = [backend.brokerFees,backend.communications,backend.commissions,backend.stripeWebhook,backend.sendInvoice];
  const functions = [...writers,backend.crmAccess,backend.pfElection];
  const grants = new Map<typeof functions[number],PolicyStatement[]>();
  const add = (fn:typeof functions[number],actions:string[],resources:string[]) => {
    grants.set(fn,[...(grants.get(fn)??[]),new PolicyStatement({actions,resources})]);
  };
  const reads=['dynamodb:GetItem','dynamodb:BatchGetItem','dynamodb:Query','dynamodb:ConditionCheckItem'];
  const writes=['dynamodb:PutItem','dynamodb:UpdateItem'];
  for(const fn of functions) {
    fn.addEnvironment('BROKER_FEE_TABLE',fees.tableName);
    add(fn,[...reads,...(writers.includes(fn as typeof writers[number])?writes:[])],[fees.tableArn,`${fees.tableArn}/index/*`]);
  }
  for(const fn of [backend.brokerFees,backend.stripeWebhook]) {
    fn.addEnvironment('COMMISSION_TABLE',commissionTable.tableName);
    fn.addEnvironment('ACCESS_API_ID',api.apiId);
    add(fn,[...reads,...writes],[commissionTable.tableArn,`${commissionTable.tableArn}/index/*`]);
  }
  for(const fn of [backend.brokerFees,backend.sendInvoice,backend.pfElection,backend.communications]) {
    fn.addEnvironment('ACCESS_API_ID',api.apiId);
    fn.addEnvironment('COMMUNICATION_TABLE',communicationTable.tableName);
    add(fn,reads,[communicationTable.tableArn,`${communicationTable.tableArn}/index/*`]);
  }
  backend.brokerFees.addEnvironment('SITE_URL',siteUrl);
  backend.communications.addEnvironment('SITE_URL',siteUrl);
  backend.brokerFees.addEnvironment('DOCUMENT_BUCKET',backend.storage.resources.bucket.bucketName);
  add(backend.brokerFees,['s3:GetObject','s3:PutObject'],[backend.storage.resources.bucket.arnForObjects('documents/*')]);
  const modelArn=(model:string)=>Stack.of(api).formatArn({service:'dynamodb',resource:'table',resourceName:`${model}-${api.apiId}-NONE`});
  for(const fn of [backend.brokerFees,backend.communications,backend.stripeWebhook,backend.commissions,backend.sendInvoice,backend.pfElection]) {
    const models=fn===backend.brokerFees?['Account','Quote','Policy','Invoice','InvoiceLine','Document','AgencySettings']
      :[backend.communications,backend.sendInvoice,backend.pfElection].includes(fn as typeof backend.communications)?['AgencySettings','Quote','Account','Policy','Invoice','PfLoan']
      :['Quote','Policy','Document','AgencySettings'];
    add(fn,reads,models.flatMap(model=>[modelArn(model),`${modelArn(model)}/index/*`]));
    const writable=fn===backend.brokerFees?['Account','Invoice','Document','Policy','AgencySettings']:fn===backend.stripeWebhook?['Policy']:fn===backend.commissions?['Document']:[];
    if(writable.length)add(fn,writes,writable.map(modelArn));
  }
  let index=0;
  for(const [fn,statements]of grants)new Policy(permissions,`BrokerFeeAccess${index++}`,{roles:[fn.resources.lambda.role!],statements});
  new Rule(Stack.of(backend.brokerFees.resources.lambda),'BrokerFeeReceiptRecovery',{
    schedule:Schedule.rate(Duration.minutes(5)),targets:[new LambdaFunction(backend.brokerFees.resources.lambda)],
    description:'Retry broker-fee allocations after settlement, binding, or temporary ledger failures.',
  });
}
