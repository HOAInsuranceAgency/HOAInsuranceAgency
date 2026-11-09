// @vitest-environment node
import { App, NestedStack, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AttributeType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Code, Function as Lambda, Runtime } from 'aws-cdk-lib/aws-lambda';
import { readFileSync } from 'node:fs';
import { expect, expectTypeOf, it } from 'vitest';
import { bindPremiumFinanceTables, type FinanceBindingGroup } from '../../amplify/finance-bindings';

// Independent contract captured from the pre-refactor bindings. Do not derive
// expected environments or grants from the feature's implementation registry.
const expected = {
  pfAdmin: [['AGENCY_SETTINGS_TABLE', 'AgencySettings', 'readWrite'], ['PF_COMPLIANCE_LOG_TABLE', 'PfComplianceLog', 'readWrite']],
  pfOriginate: [['PF_COMPLIANCE_LOG_TABLE', 'PfComplianceLog', 'readWrite'], ['AGENCY_SETTINGS_TABLE', 'AgencySettings', 'read'], ['PF_LOAN_TABLE', 'PfLoan', 'readWrite'], ['POLICY_TABLE', 'Policy', 'readUpdate'], ['INVOICE_TABLE', 'Invoice', 'read']],
  pfServicing: [['PF_COMPLIANCE_LOG_TABLE', 'PfComplianceLog', 'readWrite'], ['PF_LOAN_TABLE', 'PfLoan', 'readWrite'], ['PF_LOAN_PAYMENT_TABLE', 'PfLoanPayment', 'readWrite'], ['PF_NOTICE_TABLE', 'PfNotice', 'readWrite']],
  pfDefaultSweep: [['PF_COMPLIANCE_LOG_TABLE', 'PfComplianceLog', 'readWrite'], ['PF_LOAN_TABLE', 'PfLoan', 'readWrite']],
  sendInvoice: [['INVOICE_TABLE', 'Invoice', 'readWrite'], ['PF_LOAN_TABLE', 'PfLoan', 'readWrite'], ['PF_COMPLIANCE_LOG_TABLE', 'PfComplianceLog', 'write'], ['AGENCY_SETTINGS_TABLE', 'AgencySettings', 'read']],
  stripeWebhook: [['ACCOUNT_TABLE', 'Account', 'read'], ['POLICY_TABLE', 'Policy', 'read'], ['CARRIER_TABLE', 'Carrier', 'read'], ['PF_LOAN_TABLE', 'PfLoan', 'readWrite'], ['PF_COMPLIANCE_LOG_TABLE', 'PfComplianceLog', 'write'], ['AGENCY_SETTINGS_TABLE', 'AgencySettings', 'read'], ['PF_LOAN_PAYMENT_TABLE', 'PfLoanPayment', 'readWrite']],
  pfElection: [['INVOICE_TABLE', 'Invoice', 'readWrite'], ['PF_LOAN_TABLE', 'PfLoan', 'readWrite'], ['PF_COMPLIANCE_LOG_TABLE', 'PfComplianceLog', 'write'], ['AGENCY_SETTINGS_TABLE', 'AgencySettings', 'read']],
  pfAutopay: [['PF_LOAN_TABLE', 'PfLoan', 'readWrite'], ['PF_COMPLIANCE_LOG_TABLE', 'PfComplianceLog', 'write'], ['PF_LOAN_PAYMENT_TABLE', 'PfLoanPayment', 'readWrite']],
} as const;
type Target = keyof typeof expected;
const targets = Object.keys(expected) as Target[];
const groups: FinanceBindingGroup[] = ['administration', 'origination', 'servicing', 'defaultSweep', 'invoicePublication', 'invoiceOrigination', 'webhookReporting', 'webhookSettlement', 'electionCheckout', 'electionFlag', 'autopay'];

function fixture() {
  const app = new App(), root = new Stack(app, 'FinanceFixture', { env: { account: '111111111111', region: 'us-east-1' } });
  const data = new NestedStack(root, 'Data'), storage = new NestedStack(root, 'Storage');
  const models = ['AgencySettings', 'PfComplianceLog', 'PfLoan', 'PfLoanPayment', 'PfNotice', 'Invoice', 'Account', 'Policy', 'Carrier'] as const;
  const tables = Object.fromEntries(models.map(model => {
    const table = new Table(storage, model, { partitionKey: { name: 'id', type: AttributeType.STRING } });
    table.addGlobalSecondaryIndex({ indexName: 'by-account', partitionKey: { name: 'accountId', type: AttributeType.STRING } });
    return [model, table];
  })) as Record<typeof models[number], Table>;
  const functions = Object.fromEntries(targets.map(name => {
    const lambda = new Lambda(data, name, { runtime: Runtime.NODEJS_22_X, handler: 'index.handler', code: Code.fromInline('exports.handler = async () => {};') });
    lambda.addEnvironment('EXISTING_VALUE', name);
    lambda.addToRolePolicy(new PolicyStatement({ actions: ['sns:Publish'], resources: ['arn:aws:sns:us-east-1:111111111111:existing-topic'] }));
    return [name, { resources: { lambda }, addEnvironment: (key: string, value: string) => { lambda.addEnvironment(key, value); } }];
  })) as Record<Target, { resources: { lambda: Lambda }; addEnvironment: (key: string, value: string) => void }>;
  const backend = { ...functions, data: { resources: { tables } } };
  const render = () => {
    app.synth();
    return { root: Template.fromStack(root).toJSON(), data: Template.fromStack(data).toJSON(), storage: Template.fromStack(storage).toJSON() };
  };
  return { backend, tables, functions, render };
}

function legacyBindings(value: ReturnType<typeof fixture>) {
  for (const name of targets) for (const [key, model, access] of expected[name]) {
    const table = value.tables[model], fn = value.functions[name];
    fn.addEnvironment(key, table.tableName);
    if (access === 'read' || access === 'readUpdate') table.grantReadData(fn.resources.lambda);
    else if (access === 'write') table.grantWriteData(fn.resources.lambda);
    else table.grantReadWriteData(fn.resources.lambda);
    if (access === 'readUpdate') table.grant(fn.resources.lambda, 'dynamodb:UpdateItem');
    if ((name === 'sendInvoice' && key === 'PF_LOAN_TABLE') || (name === 'pfElection' && key === 'PF_COMPLIANCE_LOG_TABLE')) {
      fn.addEnvironment('SITE_URL', 'https://example.invalid');
    }
  }
}

function currentBindings(value: ReturnType<typeof fixture>) {
  for (const group of groups) {
    bindPremiumFinanceTables(value.backend as unknown as Parameters<typeof bindPremiumFinanceTables>[0], group);
    if (group === 'invoicePublication') value.functions.sendInvoice.addEnvironment('SITE_URL', 'https://example.invalid');
    if (group === 'electionCheckout') value.functions.pfElection.addEnvironment('SITE_URL', 'https://example.invalid');
  }
}

it('renders identical environments, IAM statements, stack placement and resource IDs for all 31 bindings', () => {
  const before = fixture(), after = fixture();
  legacyBindings(before); currentBindings(after);
  expect(after.render()).toEqual(before.render());
  expect(targets.reduce((count, name) => count + expected[name].length, 0)).toBe(31);
});

it('preserves serialized template bytes around the independent legacy SITE_URL insertion points', () => {
  const before = fixture(), after = fixture();
  legacyBindings(before); currentBindings(after);
  expect(JSON.stringify(after.render())).toBe(JSON.stringify(before.render()));
  const backend = readFileSync(new URL('../../amplify/backend.ts', import.meta.url), 'utf8');
  expect(backend).toContain(`bindPremiumFinanceTables(backend, 'invoicePublication');\nbackend.sendInvoice.addEnvironment("SITE_URL", siteBaseUrl);\nbindPremiumFinanceTables(backend, 'invoiceOrigination');`);
  expect(backend).toContain(`bindPremiumFinanceTables(backend, 'electionCheckout');\nbackend.pfElection.addEnvironment("SITE_URL", siteBaseUrl);\nbindPremiumFinanceTables(backend, 'electionFlag');`);
});

it('keeps eight existing inline policies and never adds a policy, role, table or managed policy in another stack', () => {
  const value = fixture(); currentBindings(value);
  const rendered = value.render();
  const resources = Object.values(rendered.data.Resources) as { Type: string; Properties: Record<string, unknown> }[];
  expect(resources.filter(resource => resource.Type === 'AWS::IAM::Policy')).toHaveLength(8);
  expect(resources.filter(resource => resource.Type === 'AWS::IAM::Role')).toHaveLength(8);
  expect(resources.filter(resource => resource.Type === 'AWS::IAM::ManagedPolicy')).toEqual([]);
  for (const template of [rendered.root, rendered.storage]) {
    expect(Object.values(template.Resources).filter((resource: unknown) => (resource as { Type: string }).Type.startsWith('AWS::IAM::'))).toEqual([]);
  }
  expect(Object.values(rendered.storage.Resources).filter((resource: unknown) => (resource as { Type: string }).Type === 'AWS::DynamoDB::Table')).toHaveLength(9);
});

it('retains ConditionCheckItem for flag reads without broadening append-only log writers', () => {
  const value = fixture(); currentBindings(value);
  const template = value.render().data;
  type Statement = { Action: string | string[]; Resource: unknown };
  const resources = template.Resources as Record<string, { Type: string; Properties: { PolicyDocument?: { Statement: Statement[] } } }>;
  const actions = (target: string, model: string) => {
    const policy = Object.entries(resources).find(([id, resource]) => resource.Type === 'AWS::IAM::Policy' && id.startsWith(target));
    expect(policy).toBeDefined();
    return policy![1].Properties.PolicyDocument!.Statement.filter(statement => JSON.stringify(statement.Resource).includes(model)).flatMap(statement => [statement.Action].flat());
  };
  for (const target of ['sendInvoice', 'pfElection', 'pfOriginate', 'stripeWebhook']) {
    expect(actions(target, 'AgencySettings')).toContain('dynamodb:ConditionCheckItem');
    expect(actions(target, 'AgencySettings')).not.toContain('dynamodb:PutItem');
  }
  for (const target of ['sendInvoice', 'pfElection', 'pfAutopay', 'stripeWebhook']) {
    expect(actions(target, 'PfComplianceLog')).toContain('dynamodb:PutItem');
    expect(actions(target, 'PfComplianceLog')).not.toContain('dynamodb:GetItem');
    expect(actions(target, 'PfComplianceLog')).not.toContain('dynamodb:ConditionCheckItem');
  }
  expect(actions('pfAdmin', 'AgencySettings')).toContain('dynamodb:PutItem');
  expect(actions('pfOriginate', 'Policy')).toContain('dynamodb:UpdateItem');
  expect(actions('pfOriginate', 'Policy')).not.toContain('dynamodb:PutItem');
  expect(actions('pfServicing', 'PfNotice')).toContain('dynamodb:UpdateItem');
});

it('closes the accepted binding groups at compile time', () => {
  expectTypeOf<FinanceBindingGroup>().toEqualTypeOf<'administration' | 'origination' | 'servicing' | 'defaultSweep' | 'invoicePublication' | 'invoiceOrigination' | 'webhookReporting' | 'webhookSettlement' | 'electionCheckout' | 'electionFlag' | 'autopay'>();
  const invalidGroup = (backend: Parameters<typeof bindPremiumFinanceTables>[0]) => {
    // @ts-expect-error A caller cannot select an arbitrary provider, table or group.
    bindPremiumFinanceTables(backend, 'allTables');
  };
  void invalidGroup;
});
