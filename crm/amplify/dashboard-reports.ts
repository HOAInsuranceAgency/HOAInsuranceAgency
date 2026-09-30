import { CfnResource, Stack } from 'aws-cdk-lib';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { backend as Backend } from './backend';

type Index = { indexName: string; keySchema: { attributeName: string; keyType: string }[]; projection: { projectionType: string; nonKeyAttributes?: string[] } };
type Properties = { globalSecondaryIndexes?: Index[]; attributeDefinitions?: { attributeName: string; attributeType: string }[] };

/** Index existing attributes so DynamoDB backfills historical records without
 * rewriting business data. Each affected table gains only one new index. */
export function installDashboardReads(backend: typeof Backend) {
  const api = backend.data.resources.graphqlApi;
  const generated = backend.stack.node.root.node.findAll().filter((node): node is CfnResource =>
    node instanceof CfnResource && node.cfnResourceType === 'Custom::AmplifyDynamoDBTable');
  function tableResource(model: string) {
    const resource = generated.find(node => node.node.path.endsWith(`/${model}/${model}Table/Default/Default`));
    if (!resource) throw new Error(`Missing ${model} table for dashboard reads`);
    const template = Stack.of(resource).resolve(resource._toCloudFormation());
    const properties = Object.values(template.Resources as Record<string, { Properties: Properties }>)[0].Properties;
    return { resource, properties };
  }
  function addIndex(model: string, indexName: string, hash: string, range: string | undefined, fields: string[]) {
    const { resource, properties } = tableResource(model);
    const indexes = [...properties.globalSecondaryIndexes ?? []], definitions = [...properties.attributeDefinitions ?? []];
    if (indexes.some(index => index.indexName === indexName)) throw new Error(`Dashboard index ${indexName} is already defined`);
    const keySchema = [{ attributeName: hash, keyType: 'HASH' }, ...(range ? [{ attributeName: range, keyType: 'RANGE' }] : [])];
    indexes.push({ indexName, keySchema, projection: { projectionType: 'INCLUDE', nonKeyAttributes: fields } });
    for (const { attributeName } of keySchema) if (!definitions.some(definition => definition.attributeName === attributeName)) definitions.push({ attributeName, attributeType: 'S' });
    resource.addPropertyOverride('globalSecondaryIndexes', indexes);
    resource.addPropertyOverride('attributeDefinitions', definitions);
    return indexName;
  }
  function relationIndex(model: string, partition: string) {
    const index = tableResource(model).properties.globalSecondaryIndexes?.find(index => index.projection.projectionType === 'ALL' && index.keySchema.length === 1 && index.keySchema[0].attributeName === partition);
    if (!index) throw new Error(`Missing ${model}.${partition} relation index for dashboard`);
    return index.indexName;
  }
  const paymentIndex = addIndex('PfLoanPayment', 'dashboardPaymentsByDate', '__typename', 'postedAt', ['accountId', 'interest']);
  const boundIndex = addIndex('Policy', 'dashboardPoliciesByBindDate', '__typename', 'datePolicyBound', ['accountId']);
  const quoteStatusIndex = addIndex('Quote', 'dashboardQuotesByStatus', 'status', undefined, ['accountId']);
  const quoteAccountIndex = relationIndex('Quote', 'accountId'), invoiceLineIndex = relationIndex('InvoiceLine', 'invoiceId');

  // API-derived names avoid cycles through the model's own nested stack.
  const name = (model: string) => `${model}-${api.apiId}-NONE`;
  const arn = (model: string) => Stack.of(api).formatArn({ service: 'dynamodb', resource: 'table', resourceName: name(model) });
  const env: Record<string, string> = {
    DASHBOARD_PAYMENT_TABLE: name('PfLoanPayment'), DASHBOARD_PAYMENT_INDEX: paymentIndex,
    DASHBOARD_POLICY_TABLE: name('Policy'), DASHBOARD_POLICY_DATE_INDEX: boundIndex,
    DASHBOARD_QUOTE_TABLE: name('Quote'), DASHBOARD_QUOTE_STATUS_INDEX: quoteStatusIndex, DASHBOARD_QUOTE_ACCOUNT_INDEX: quoteAccountIndex,
    DASHBOARD_INVOICE_LINE_TABLE: name('InvoiceLine'), DASHBOARD_INVOICE_LINE_INDEX: invoiceLineIndex,
  };
  for (const [key, value] of Object.entries(env)) backend.communications.addEnvironment(key, value);
  const lambda = backend.communications.resources.lambda;
  lambda.addToRolePolicy(new PolicyStatement({ actions: ['dynamodb:Query'], resources: [
    `${arn('PfLoanPayment')}/index/${paymentIndex}`, `${arn('Policy')}/index/${boundIndex}`, `${arn('Quote')}/index/${quoteStatusIndex}`,
  ] }));
  lambda.addToRolePolicy(new PolicyStatement({ actions: ['dynamodb:BatchGetItem'], resources: [arn('Policy'), arn('Quote')] }));
  const partitionResources = [arn('Quote'), `${arn('Quote')}/index/${quoteAccountIndex}`, arn('InvoiceLine'), `${arn('InvoiceLine')}/index/${invoiceLineIndex}`];
  lambda.addToRolePolicy(new PolicyStatement({ actions: ['dynamodb:PartiQLSelect'], resources: partitionResources, conditions: { Bool: { 'dynamodb:FullTableScan': 'false' } } }));
  lambda.addToRolePolicy(new PolicyStatement({ effect: Effect.DENY, actions: ['dynamodb:PartiQLSelect'], resources: partitionResources, conditions: { Bool: { 'dynamodb:FullTableScan': 'true' } } }));
}
