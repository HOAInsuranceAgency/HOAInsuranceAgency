import { createHash } from 'node:crypto';
import contract from '../../../amplify/steady-state-main.json';
import stagingContract from '../../../amplify/steady-state-staging.json';
// @ts-expect-error JavaScript deployment-only allowlist
import { ACCOUNT_LIST_EXTENSION, ACCOUNT_LIST_STAGING_EXTENSION } from '../../../scripts/steady-state-account-list.mjs';

export type Resource = { LogicalResourceId: string; PhysicalResourceId: string; ResourceType: string; ResourceStatus: string };
export function fixture(failure = '', staging = false, withLedger = false) {
  const c = structuredClone(staging ? stagingContract : contract), calls: string[][] = [];
  const e = staging ? ACCOUNT_LIST_STAGING_EXTENSION : ACCOUNT_LIST_EXTENSION;
  const row = (logical: string, type: string, physical: string): Resource => ({ LogicalResourceId: logical, ResourceType: type, PhysicalResourceId: physical, ResourceStatus: 'CREATE_COMPLETE' });
  const tableArn = (name: string) => `arn:aws:dynamodb:${c.region}:${c.account}:table/${name}`;
  const sourceNames: Record<string, string> = {}, streams: Record<string, string> = {};
  for (const model of ['Account', 'Contact', 'Quote', 'Policy']) {
    streams[model] = c.mappings.find(m => m.streamArn.startsWith(tableArn(`${model}-`)))!.streamArn;
    sourceNames[model] = streams[model].slice(tableArn('').length).split('/stream/')[0];
  }
  sourceNames.UserProfile = sourceNames.Account.replace(/^Account-/, 'UserProfile-');
  sourceNames.Communication = 'main-communication-records';
  streams.UserProfile = `${tableArn(sourceNames.UserProfile)}/stream/2026-11-04T12:00:00.000`;
  streams.Communication = `${tableArn(sourceNames.Communication)}/stream/2026-10-29T20:00:00.000`;
  const stateful = [
    ...Object.entries(sourceNames).map(([model, name]) => row(model === 'Communication' ? e.communicationTable : `${model}OriginalTable`, model === 'Communication' ? 'AWS::DynamoDB::Table' : 'Custom::AmplifyDynamoDBTable', name)),
    ...Array.from({ length: 51 }, (_, i) => row(`OriginalState${i}`, 'AWS::DynamoDB::Table', `original-table-${i}`)),
  ];
  const tuples = stateful.map(r => [c.backendRoot, r.LogicalResourceId, r.ResourceType, r.PhysicalResourceId]);
  tuples.sort((a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; });
  c.statefulInventorySha256 = createHash('sha256').update(JSON.stringify(tuples)).digest('hex');
  const workerStack = `arn:aws:cloudformation:${c.region}:${c.account}:stack/account-list-owned/12345678`;
  const workerName = 'main-account-list-worker', schedulerRole = 'main-account-list-scheduler-role', scheduleName = 'main-account-list-schedule';
  const workerArn = `arn:aws:lambda:${c.region}:${c.account}:function:${workerName}`;
  const root = [
    ...stateful,
    ...c.mappings.map(m => row(m.logical, 'AWS::Lambda::EventSourceMapping', m.uuid)),
    ...c.schedules.map(s => row(s.logical, 'AWS::Scheduler::Schedule', s.name)),
    row(e.table, 'AWS::DynamoDB::Table', 'main-account-list-records'),
    row(e.workerStack, 'AWS::CloudFormation::Stack', workerStack),
  ];
  const ledgerName = `${c.backendRoot.split('/')[1]}-broker-fees`;
  const ledgerResource = row('BrokerFeeLedger1234ABCD', 'AWS::DynamoDB::Table', ledgerName);
  if (withLedger) root.push(ledgerResource);
  const ledger = { TableName: ledgerName, TableArn: tableArn(ledgerName), TableStatus: 'ACTIVE', DeletionProtectionEnabled: failure !== 'unprotected-ledger',
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }], AttributeDefinitions: ['id', 'accountId', 'kind', 'pending'].map(AttributeName => ({ AttributeName, AttributeType: 'S' })),
    GlobalSecondaryIndexes: Object.entries({ account: 'accountId', kind: 'kind', pending: 'pending' }).map(([IndexName, key]) => ({ IndexName, IndexStatus: 'ACTIVE', Projection: { ProjectionType: 'ALL' }, KeySchema: [{ AttributeName: key, KeyType: 'HASH' }, { AttributeName: 'id', KeyType: 'RANGE' }] })) };
  const worker = [
    row(e.worker, 'AWS::Lambda::Function', workerName), row(e.schedulerRole, 'AWS::IAM::Role', schedulerRole),
    row(e.schedule, 'AWS::Scheduler::Schedule', scheduleName),
    ...Object.entries(e.mappings as Record<string, string>).map(([model, logical]) => row(logical, 'AWS::Lambda::EventSourceMapping', `new-${model}-cursor`)),
  ];
  const commissionPayroll = staging ? (c as typeof stagingContract).stagingScheduleExtension.commissionPayroll : undefined;
  const commissionResources = commissionPayroll ? [row(commissionPayroll.logical, 'AWS::Scheduler::Schedule', commissionPayroll.name)] : [];
  const commissionSchedule = commissionPayroll ? {
    Name: commissionPayroll.name, State: commissionPayroll.state, Target: structuredClone(commissionPayroll.target),
    ScheduleExpression: commissionPayroll.scheduleExpression, ScheduleExpressionTimezone: commissionPayroll.scheduleExpressionTimezone,
    FlexibleTimeWindow: structuredClone(commissionPayroll.flexibleTimeWindow),
  } : undefined;
  if (commissionPayroll) root.push(row('commissionpayrollC11FCD08', 'AWS::CloudFormation::Stack', commissionPayroll.stackArn));
  if (failure === 'missing-table') root.splice(root.findIndex(r => r.LogicalResourceId === e.table), 1);
  if (failure === 'missing-mapping') worker.splice(worker.findIndex(r => r.LogicalResourceId === e.mappings.Contact), 1);
  if (failure === 'missing-schedule') worker.splice(worker.findIndex(r => r.LogicalResourceId === e.schedule), 1);
  if (failure === 'missing-worker') worker.splice(worker.findIndex(r => r.LogicalResourceId === e.worker), 1);
  if (failure === 'wrong-type') root.find(r => r.LogicalResourceId === e.table)!.ResourceType = 'AWS::S3::Bucket';
  if (failure === 'duplicate-id') root.push({ ...root.find(r => r.LogicalResourceId === e.table)! });
  if (failure === 'extra-table') root.push(row('UnexpectedNewTable', 'AWS::DynamoDB::Table', 'foreign-table'));
  if (failure === 'extra-mapping') worker.push(row('UnexpectedNewMapping', 'AWS::Lambda::EventSourceMapping', 'extra-cursor'));
  if (failure === 'extra-schedule') worker.push(row('UnexpectedNewSchedule', 'AWS::Scheduler::Schedule', 'extra-schedule'));
  if (failure === 'old-stateful-change') root[0].PhysicalResourceId = 'replacement-account';
  if (failure === 'old-cursor-change') root.find(r => r.PhysicalResourceId === c.mappings[0].uuid)!.PhysicalResourceId = 'replacement-old-cursor';
  if (failure === 'old-schedule-change') root.find(r => r.PhysicalResourceId === c.schedules[0].name)!.PhysicalResourceId = 'replacement-old-schedule';
  if (failure === 'foreign-table-stack') { const table = root.splice(root.findIndex(r => r.LogicalResourceId === e.table), 1)[0]; worker.push(table); }
  if (failure === 'foreign-worker-stack') { const fn = worker.splice(worker.findIndex(r => r.LogicalResourceId === e.worker), 1)[0]; root.push(fn); }
  const aws = (...args: string[]): unknown => {
    calls.push(args);
    if (args[1] === 'describe-stacks') return { Stacks: [{ StackId: c.backendRoot, StackStatus: 'UPDATE_COMPLETE', EnableTerminationProtection: true }] };
    if (args[1] === 'list-stack-resources') {
      if (args[3] === c.backendRoot) return { StackResourceSummaries: root };
      if (args[3] === workerStack) return { StackResourceSummaries: worker };
      if (commissionPayroll && args[3] === commissionPayroll.stackArn) return { StackResourceSummaries: commissionResources };
      throw new Error(`Unexpected fixture stack: ${args[3]}`);
    }
    if (args[1] === 'describe-table') {
      const name = args[3], model = Object.keys(sourceNames).find(model => sourceNames[model] === name);
      if (name === ledgerName) return { Table: ledger };
      if (!model) return { Table: { TableName: name, TableArn: tableArn(name), TableStatus: 'ACTIVE', KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: failure === 'private-schema' ? 'wrong' : 'sk', KeyType: 'RANGE' }] } };
      return { Table: { TableName: name, TableArn: failure === 'foreign-source' && model === 'UserProfile' ? tableArn('foreign') : tableArn(name), TableStatus: 'ACTIVE',
        LatestStreamArn: failure === 'source-generation' && model === 'Account' ? `${tableArn(name)}/stream/replaced` : streams[model],
        StreamSpecification: { StreamEnabled: true, StreamViewType: failure === 'source-view' ? 'KEYS_ONLY' : 'NEW_AND_OLD_IMAGES' }, KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }] } };
    }
    if (args[1] === 'get-event-source-mapping') {
      const old = c.mappings.find(m => m.uuid === args[3]);
      if (old) return { UUID: old.uuid, FunctionArn: old.functionArn, EventSourceArn: old.streamArn, State: 'Enabled', StartingPosition: 'LATEST', LastProcessingResult: 'OK' };
      const model = Object.keys(e.mappings).find(model => `new-${model}-cursor` === args[3])!;
      return { UUID: args[3], FunctionArn: failure === 'foreign-function' ? `${workerArn}-wrong` : workerArn,
        EventSourceArn: failure === 'foreign-stream' ? `${tableArn('foreign')}/stream/other` : streams[model],
        State: failure === 'disabled-mapping' ? 'Disabled' : 'Enabled', StartingPosition: failure === 'replay' ? 'TRIM_HORIZON' : 'LATEST', LastProcessingResult: failure === 'mapping-errors' ? 'PROBLEM: failure' : 'OK',
        BatchSize: failure === 'batch-size' ? 100 : 25, MaximumBatchingWindowInSeconds: 1, MaximumRecordAgeInSeconds: 7200, MaximumRetryAttempts: 10,
        FunctionResponseTypes: ['ReportBatchItemFailures'], ...(failure === 'mapping-filter' ? { FilterCriteria: { Filters: [{ Pattern: '{}' }] } } : {}) };
    }
    if (args[1] === 'get-schedule') {
      const old = c.schedules.find(s => s.name === args[3]);
      if (old) return { Name: old.name, State: old.state, Target: old.target, ScheduleExpression: old.scheduleExpression, ScheduleExpressionTimezone: old.scheduleExpressionTimezone, FlexibleTimeWindow: old.flexibleTimeWindow };
      if (commissionSchedule && args[3] === commissionSchedule.Name) return commissionSchedule;
      return { Name: scheduleName, State: failure === 'disabled-schedule' ? 'DISABLED' : 'ENABLED', ScheduleExpression: failure === 'schedule-timing' ? 'rate(1 minute)' : 'cron(* * * * ? *)', ScheduleExpressionTimezone: 'America/New_York', FlexibleTimeWindow: { Mode: 'OFF' },
        Target: { Arn: workerArn, RoleArn: `arn:aws:iam::${failure === 'foreign-role' ? '000000000000' : c.account}:role/${schedulerRole}`,
          RetryPolicy: { MaximumEventAgeInSeconds: 86400, MaximumRetryAttempts: 185 }, ...(failure === 'schedule-input' ? { Input: '{"unexpected":true}' } : {}) } };
    }
    throw new Error(`Unexpected read: ${args.join(' ')}`);
  };
  return { c, aws, calls, root, worker, resources: root, ledger, ledgerResource, commissionResources, commissionSchedule,
    namespace: { branchName: c.backendBranch, enableAutoBuild: false, enablePullRequestPreview: false, backend: { stackArn: c.backendRoot } } };
}

