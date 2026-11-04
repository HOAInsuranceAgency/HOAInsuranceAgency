// @vitest-environment node
import { App, Stack, NestedStack } from 'aws-cdk-lib';
import { Table, AttributeType } from 'aws-cdk-lib/aws-dynamodb';
import { Role, ServicePrincipal, Policy, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { expect, it } from 'vitest';
import { checkBrokerFeeCallerAccess } from '../../scripts/check-broker-fee-access';

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
    new Policy(permissions, name, { roles: [role], statements: [new PolicyStatement({
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
