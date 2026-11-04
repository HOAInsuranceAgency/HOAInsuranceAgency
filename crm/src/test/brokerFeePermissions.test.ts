// @vitest-environment node
import { App, CfnResource, Stack, NestedStack } from 'aws-cdk-lib';
import { Table, AttributeType } from 'aws-cdk-lib/aws-dynamodb';
import { Role, ServicePrincipal, ManagedPolicy, Policy, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { expect, it } from 'vitest';
import { checkBrokerFeeCallerAccess } from '../../scripts/check-broker-fee-access';
import { installBrokerFees } from '../../amplify/broker-fees';

function fixture(writeInlineCaller: boolean) {
  const app = new App();
  const root = new Stack(app, 'Root');
  const data = new NestedStack(root, 'Data');
  const ledger = new NestedStack(root, 'Ledger');
  const permissions = new NestedStack(root, 'Permissions');
  const table = new Table(ledger, 'BrokerFeeLedger', { partitionKey: { name: 'id', type: AttributeType.STRING } });
  const voidInvoice = new Role(data, 'VoidInvoiceRole', { assumedBy: new ServicePrincipal('lambda.amazonaws.com') });
  const pfElection = new Role(data, 'PfElectionRole', { assumedBy: new ServicePrincipal('lambda.amazonaws.com') });
  for (const [name, role, write] of [['Void', voidInvoice, true], ['Election', pfElection, writeInlineCaller]] as const) {
    new ManagedPolicy(permissions, name, { roles: [role], statements: [new PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:ConditionCheckItem', ...(write ? ['dynamodb:PutItem'] : [])], resources: [table.tableArn],
    })] });
  }
  app.synth();
  return { app, root, callers: { voidInvoice, pfElection } };
}

it('requires ledger writes on the inline financing caller even when the standalone void role can write', () => {
  const { root, callers } = fixture(false);
  expect(() => checkBrokerFeeCallerAccess(root, callers)).toThrow('pfElection lacks broker fee claim-release permission: dynamodb:PutItem');
});

it('accepts actual cross-stack claim-release policies for both callers without altering dependencies', () => {
  const { root, callers } = fixture(true);
  const dependencies = JSON.stringify(root.node.dependencies.map(item => item.node.path));
  expect(() => checkBrokerFeeCallerAccess(root, callers)).not.toThrow();
  expect(JSON.stringify(root.node.dependencies.map(item => item.node.path))).toBe(dependencies);
});

it('installs bounded managed grants without consuming the communications role inline-policy budget', () => {
  const app = new App(), root = new Stack(app, 'BrokerFeeDeployment');
  const data = new NestedStack(root, 'Data');
  const api = Object.assign(new Construct(data, 'Api'), { apiId: 'fixture-api-id' });
  const functions = Object.fromEntries(['brokerFees','communications','commissions','stripeWebhook','sendInvoice','voidInvoice','pfElection','crmAccess'].map(name => {
    const fn = new Function(data, name, { runtime: Runtime.NODEJS_22_X, handler: 'index.handler', code: Code.fromInline('exports.handler = async () => {};') });
    return [name, { resources: { lambda: fn }, addEnvironment: (key: string, value: string) => fn.addEnvironment(key, value) }];
  }));
  const communicationsRole = functions.communications.resources.lambda.role!;
  new Policy(data, 'ExistingCommunicationsPermissions', { roles: [communicationsRole], statements: [new PolicyStatement({
    actions: ['s3:GetObject'], resources: Array.from({ length: 80 }, (_, i) => `arn:aws:s3:::existing-communications-source-${i}/${'x'.repeat(70)}`),
  })] });
  const backend = { ...functions, stack: root, createStack: (name: string) => new NestedStack(root, name),
    data: { resources: { graphqlApi: api } }, storage: { resources: { bucket: new Bucket(data, 'Documents') } },
  };
  const communicationTable = new Table(data, 'Communications', { partitionKey: { name: 'id', type: AttributeType.STRING } });
  const commissionTable = new Table(data, 'Commissions', { partitionKey: { name: 'id', type: AttributeType.STRING } });
  installBrokerFees(backend as unknown as Parameters<typeof installBrokerFees>[0], communicationTable, commissionTable, 'https://agency.example.test');
  app.synth();
  const resources = root.node.findAll().filter((node): node is CfnResource => node instanceof CfnResource).map(node =>
    Object.values(Stack.of(node).resolve(node._toCloudFormation()).Resources as Record<string, any>)[0]);
  const feePolicies = resources.filter(resource => JSON.stringify(resource.Properties?.PolicyDocument ?? {}).includes('BrokerFeeLedger'));
  expect(feePolicies).toHaveLength(8);
  expect(feePolicies.every(resource => resource.Type === 'AWS::IAM::ManagedPolicy')).toBe(true);
  for (const policy of feePolicies) {
    expect(policy.Properties.Roles).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(policy.Properties.PolicyDocument))).toBeLessThanOrEqual(6144);
  }
  const existingInline = resources.filter(resource => resource.Type === 'AWS::IAM::Policy');
  expect(existingInline).toHaveLength(1);
  const inlineBytes = Buffer.byteLength(JSON.stringify(existingInline[0].Properties.PolicyDocument));
  expect(inlineBytes).toBeGreaterThan(9000);
  expect(inlineBytes).toBeLessThanOrEqual(10240);
  expect(() => checkBrokerFeeCallerAccess(root, { voidInvoice: functions.voidInvoice.resources.lambda.role!, pfElection: functions.pfElection.resources.lambda.role! })).not.toThrow();
  const crmPolicy = feePolicies.find(policy => policy.Properties.Roles.some((role: unknown) => JSON.stringify(role).includes('crmAccess')));
  expect(crmPolicy).toBeDefined();
  const crmActions = crmPolicy.Properties.PolicyDocument.Statement.flatMap((statement: any) => [statement.Action].flat());
  expect(crmActions).toContain('dynamodb:GetItem');
  expect(crmActions).not.toContain('dynamodb:PutItem');
  expect(crmActions).not.toContain('dynamodb:UpdateItem');
});
