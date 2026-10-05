import { Stack, RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table, TableEncryption } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { backend as Backend } from './backend';

/** Compensation is deliberately outside the model API and shared communication
 * store. Neither native model reads nor admin activity lookups can expose it. */
export function installOwnerProfitability(backend: typeof Backend, communicationTable: Table) {
  const stack = backend.createStack('OwnerCompensation');
  const table = new Table(stack, 'EmployeeCompensation', {
    partitionKey: { name: 'kind', type: AttributeType.STRING },
    sortKey: { name: 'id', type: AttributeType.STRING },
    billingMode: BillingMode.PAY_PER_REQUEST,
    encryption: TableEncryption.AWS_MANAGED,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: RemovalPolicy.RETAIN,
  });
  const fn = backend.ownerProfitability;
  fn.addEnvironment('OWNER_COMPENSATION_TABLE', table.tableName);
  table.grantReadWriteData(fn.resources.lambda);
  fn.addEnvironment('COMMUNICATION_TABLE', communicationTable.tableName);
  fn.resources.lambda.addToRolePolicy(new PolicyStatement({
    actions: ['dynamodb:BatchGetItem'], resources: [communicationTable.tableArn],
  }));
  fn.resources.lambda.addToRolePolicy(new PolicyStatement({
    actions: ['dynamodb:Query'], resources: [`${communicationTable.tableArn}/index/kind`],
  }));
  // API-derived names avoid dependencies from model nested stacks back to a
  // function used by the API's custom query/mutation resolvers.
  const api = backend.data.resources.graphqlApi;
  for (const model of ['Policy', 'UserProfile']) {
    const name = `${model}-${api.apiId}-NONE`;
    fn.addEnvironment(`${model === 'Policy' ? 'POLICY' : 'USER_PROFILE'}_TABLE`, name);
    fn.resources.lambda.addToRolePolicy(new PolicyStatement({
      actions: ['dynamodb:Scan'], resources: [Stack.of(api).formatArn({ service: 'dynamodb', resource: 'table', resourceName: name })],
    }));
  }
}
