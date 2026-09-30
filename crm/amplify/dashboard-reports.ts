import { CfnResource, Stack } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { backend as Backend } from './backend';

/** Index existing model metadata, so DynamoDB backfills old receipts without
 * rewriting financial records or depending on historical bank-account labels. */
export function installDashboardReads(backend: typeof Backend) {
  const api = backend.data.resources.graphqlApi;
  const resource = backend.stack.node.root.node.findAll().find((node): node is CfnResource =>
    node instanceof CfnResource && node.cfnResourceType === 'Custom::AmplifyDynamoDBTable' &&
    node.node.path.endsWith('/PfLoanPayment/PfLoanPaymentTable/Default/Default'));
  if (!resource) throw new Error('Missing payment table for dashboard index');
  const template = Stack.of(resource).resolve(resource._toCloudFormation());
  type Index = { indexName: string; keySchema: { attributeName: string; keyType: string }[]; projection: { projectionType: string; nonKeyAttributes?: string[] } };
  const properties = Object.values(template.Resources as Record<string, { Properties: {
    globalSecondaryIndexes?: Index[]; attributeDefinitions?: { attributeName: string; attributeType: string }[];
  } }>)[0].Properties;
  const indexes = [...properties.globalSecondaryIndexes ?? []];
  const definitions = [...properties.attributeDefinitions ?? []];
  const indexName = 'dashboardPaymentsByDate';
  if (indexes.some(index => index.indexName === indexName)) throw new Error('Dashboard payment index is already defined');
  indexes.push({ indexName, keySchema: [{ attributeName: '__typename', keyType: 'HASH' }, { attributeName: 'postedAt', keyType: 'RANGE' }], projection: { projectionType: 'INCLUDE', nonKeyAttributes: ['accountId', 'interest'] } });
  for (const name of ['__typename', 'postedAt']) if (!definitions.some(definition => definition.attributeName === name)) definitions.push({ attributeName: name, attributeType: 'S' });
  resource.addPropertyOverride('globalSecondaryIndexes', indexes);
  resource.addPropertyOverride('attributeDefinitions', definitions);

  // API-derived names avoid cycles from model resolvers through communications
  // back to their own nested tables, matching the account-access installation.
  const paymentName = `PfLoanPayment-${api.apiId}-NONE`, policyName = `Policy-${api.apiId}-NONE`;
  backend.communications.addEnvironment('DASHBOARD_PAYMENT_TABLE', paymentName);
  backend.communications.addEnvironment('DASHBOARD_PAYMENT_INDEX', indexName);
  backend.communications.addEnvironment('DASHBOARD_POLICY_TABLE', policyName);
  const arn = (name: string) => Stack.of(api).formatArn({ service: 'dynamodb', resource: 'table', resourceName: name });
  backend.communications.resources.lambda.addToRolePolicy(new PolicyStatement({ actions: ['dynamodb:Query'], resources: [`${arn(paymentName)}/index/${indexName}`] }));
  backend.communications.resources.lambda.addToRolePolicy(new PolicyStatement({ actions: ['dynamodb:BatchGetItem'], resources: [arn(policyName)] }));
}
