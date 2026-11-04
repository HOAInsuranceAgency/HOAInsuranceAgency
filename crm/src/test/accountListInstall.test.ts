// @vitest-environment node
import { App, NestedStack, Stack } from 'aws-cdk-lib';
import { AttributeType, StreamViewType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Code, Function, Runtime, type CfnFunction } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { expect, it, vi } from 'vitest';
vi.mock('../../amplify/model-index', () => ({ modelIndex: (_scope: unknown, _model: string, field: string) => ({ name: `by_${field}` }) }));
import { installAccountList } from '../../amplify/account-list';

it('keeps the source map on the worker and reuses the reader existing API and communication-table configuration', () => {
  const app = new App(), root = new Stack(app, 'AccountListConfiguration');
  const data = new NestedStack(root, 'Data'), workerStack = new NestedStack(root, 'Worker');
  const api = Object.assign(new Construct(data, 'Api'), { apiId: 'fixture-api-id' });
  const makeFunction = (stack: Stack, name: string) => {
    const lambda = new Function(stack, name, { runtime: Runtime.NODEJS_22_X, handler: 'index.handler', code: Code.fromInline('exports.handler = async () => {};') });
    return { resources: { lambda }, addEnvironment: (key: string, value: string) => lambda.addEnvironment(key, value) };
  };
  const reader = makeFunction(data, 'Reader'), worker = makeFunction(workerStack, 'Worker');
  const communication = new Table(data, 'Communication', { partitionKey: { name: 'id', type: AttributeType.STRING }, stream: StreamViewType.NEW_AND_OLD_IMAGES });
  reader.addEnvironment('ACCESS_API_ID', api.apiId); reader.addEnvironment('COMMUNICATION_TABLE', communication.tableName);
  const models = ['Account', 'Contact', 'Quote', 'Policy', 'UserProfile'];
  const tables = Object.fromEntries(models.map(model => [model, new Table(data, model, { partitionKey: { name: 'id', type: AttributeType.STRING }, stream: StreamViewType.NEW_AND_OLD_IMAGES })]));
  const backend = { stack: root, accountListWorker: worker, communications: reader,
    data: { resources: { graphqlApi: api, tables, cfnResources: { amplifyDynamoDbTables: Object.fromEntries(models.map(model => [model, {}])) } } },
    createStack: (name: string) => new NestedStack(root, name), addOutput: vi.fn(),
  };
  const projection = installAccountList(backend as unknown as Parameters<typeof installAccountList>[0], communication);
  app.synth();
  const environment = (fn: typeof reader) => Stack.of(fn.resources.lambda).resolve((fn.resources.lambda.node.defaultChild as CfnFunction).environment) as { variables: Record<string, unknown> };
  expect(environment(reader).variables).toEqual(Stack.of(reader.resources.lambda).resolve({ ACCESS_API_ID: api.apiId, COMMUNICATION_TABLE: communication.tableName,
    ACCOUNT_LIST_TABLE: projection.tableName }));
  expect(environment(worker).variables.ACCOUNT_LIST_SOURCE_TABLES).toEqual(Stack.of(worker.resources.lambda).resolve(JSON.stringify({ Communication: communication.tableName,
    ...Object.fromEntries(models.map(model => [model, `${model}-${api.apiId}-NONE`])) })));
});
