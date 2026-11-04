// Exact logical IDs from the destination main CDK assembly. This is one
// additive, rebuildable read projection; it does not replace the frozen source
// inventory, migrated cursors or existing schedules in steady-state-main.json.
export const ACCOUNT_LIST_EXTENSION = Object.freeze({
  table: 'amplifyDataL2GraphqlApiAccountListRecordsADED7554',
  workerStack: 'accountlist28FD5CD7',
  worker: 'accountlistworkerlambdaD39EDB3D',
  schedulerRole: 'SchedulerRoleForTarget27ecbf322044B4',
  schedule: 'accountlistworkerlambdaschedule06EFA3E9C',
  communicationTable: 'amplifyDataL2GraphqlApiCommunicationRecords8E155369',
  mappings: Object.freeze({
    Account: 'accountlistworkerlambdaDynamoDBEventSourceamplifyd1nuh9rw1hcuxomainbranch0e4fdbd849dataamplifyDataAccountCustomTableAccountTableA0901AF5528DAD5BMigrationLiveV1',
    Contact: 'accountlistworkerlambdaDynamoDBEventSourceamplifyd1nuh9rw1hcuxomainbranch0e4fdbd849dataamplifyDataContactCustomTableContactTable0B537088872EB0ADMigrationLiveV1',
    Quote: 'accountlistworkerlambdaDynamoDBEventSourceamplifyd1nuh9rw1hcuxomainbranch0e4fdbd849dataamplifyDataQuoteCustomTableQuoteTable6417309249C1D16AMigrationLiveV1',
    Policy: 'accountlistworkerlambdaDynamoDBEventSourceamplifyd1nuh9rw1hcuxomainbranch0e4fdbd849dataamplifyDataPolicyCustomTablePolicyTable21B44392C28597ACMigrationLiveV1',
    UserProfile: 'accountlistworkerlambdaDynamoDBEventSourceamplifyd1nuh9rw1hcuxomainbranch0e4fdbd849dataamplifyDataUserProfileCustomTableUserProfileTable777A3FDCDA40FC93MigrationLiveV1',
    Communication: 'accountlistworkerlambdaDynamoDBEventSourceamplifyd1nuh9rw1hcuxomainbranch0e4fdbd849dataamplifyDataL2GraphqlApiCommunicationRecords6D9DF288CDFC4BDFMigrationLiveV1',
  }),
});
const requireExtension = (ok, reason) => { if (!ok) throw new Error(`HOA steady-state account-list extension: ${reason}`); };
const exactly = (inventory, logical, type) => {
  const found = inventory.filter(row => row.LogicalResourceId === logical);
  requireExtension(found.length === 1 && found[0].ResourceType === type, `exact ${logical} identity/type required`);
  return found[0];
};

/** Partition only the exact extension IDs. Any other table, mapping or
 * schedule remains in the original verifier and fails its original counts/hash.
 * Before the first deployment the extension must be wholly absent; afterward
 * all eight protected additions and their owning worker stack must be present. */
export function accountListExtension(inventory, contract) {
  const e = ACCOUNT_LIST_EXTENSION;
  const protectedIds = [e.table, e.schedule, ...Object.values(e.mappings)];
  const allIds = [...protectedIds, e.worker, e.schedulerRole, e.workerStack];
  if (!inventory.some(row => allIds.includes(row.LogicalResourceId))) return { legacy: inventory, extension: null };
  requireExtension(contract.account === '917680434255' && contract.region === 'us-east-1' && contract.crmApp === 'd1nuh9rw1hcuxo'
    && contract.backendBranch === 'main', 'allowance is bound only to destination main');
  const table = exactly(inventory, e.table, 'AWS::DynamoDB::Table');
  const stack = exactly(inventory, e.workerStack, 'AWS::CloudFormation::Stack');
  const worker = exactly(inventory, e.worker, 'AWS::Lambda::Function');
  const role = exactly(inventory, e.schedulerRole, 'AWS::IAM::Role');
  const schedule = exactly(inventory, e.schedule, 'AWS::Scheduler::Schedule');
  const mappings = Object.fromEntries(Object.entries(e.mappings).map(([model, logical]) => [model, exactly(inventory, logical, 'AWS::Lambda::EventSourceMapping')]));
  const communication = exactly(inventory, e.communicationTable, 'AWS::DynamoDB::Table');
  requireExtension(stack.stack === contract.backendRoot && worker.stack === stack.PhysicalResourceId
    && role.stack === worker.stack && schedule.stack === worker.stack && Object.values(mappings).every(row => row.stack === worker.stack)
    && table.stack === communication.stack, 'resources must remain in their exact owning backend stacks');
  requireExtension(new Set(Object.values(mappings).map(row => row.PhysicalResourceId)).size === 6
    && Object.values(mappings).every(row => !contract.mappings.some(old => old.uuid === row.PhysicalResourceId)), 'six distinct additive cursor identities required');
  return { legacy: inventory.filter(row => !protectedIds.includes(row.LogicalResourceId)), extension: { table, worker, role, schedule, mappings, communication } };
}

/** Called only after the untouched original57 identity hash,22 cursors and8
 * schedules passed. Source names therefore come from that frozen inventory.
 * UserProfile and Communication did not have migrated cursors; their exact
 * owned table and current stream generation are checked directly. */
export function verifyAccountListExtension(extension, legacy, contract, aws) {
  if (!extension) return;
  const { table, worker, role, schedule, mappings, communication } = extension;
  const tableArn = name => `arn:aws:dynamodb:${contract.region}:${contract.account}:table/${name}`;
  const functionArn = `arn:aws:lambda:${contract.region}:${contract.account}:function:${worker.PhysicalResourceId}`;
  const roleArn = `arn:aws:iam::${contract.account}:role/${role.PhysicalResourceId}`;
  const privateTable = aws('dynamodb', 'describe-table', '--table-name', table.PhysicalResourceId).Table;
  requireExtension(privateTable?.TableName === table.PhysicalResourceId && privateTable.TableArn === tableArn(table.PhysicalResourceId)
    && privateTable.TableStatus === 'ACTIVE' && JSON.stringify(privateTable.KeySchema) === JSON.stringify([{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }]), 'private projection table scope/schema changed');
  const sourceNames = {}, pinnedStreams = {};
  for (const model of ['Account', 'Contact', 'Quote', 'Policy']) {
    const streams = [...new Set(contract.mappings.map(row => row.streamArn).filter(arn => arn.startsWith(`${tableArn(`${model}-`)}`)))];
    requireExtension(streams.length === 1, `one pinned ${model} source stream required`);
    pinnedStreams[model] = streams[0]; sourceNames[model] = streams[0].slice(tableArn('').length).split('/stream/')[0];
  }
  const suffix = /^Account-([a-z0-9]{26}-NONE)$/.exec(sourceNames.Account)?.[1];
  requireExtension(!!suffix, 'source API table namespace changed');
  sourceNames.UserProfile = `UserProfile-${suffix}`;
  sourceNames.Communication = communication.PhysicalResourceId;
  for (const [model, resource] of Object.entries(mappings)) {
    const name = sourceNames[model];
    requireExtension(legacy.filter(row => row.PhysicalResourceId === name && ['Custom::AmplifyDynamoDBTable', 'AWS::DynamoDB::Table'].includes(row.ResourceType)).length === 1,
      `${model} source is not an original owned table`);
    const live = aws('dynamodb', 'describe-table', '--table-name', name).Table;
    requireExtension(live?.TableName === name && live.TableArn === tableArn(name) && live.TableStatus === 'ACTIVE'
      && typeof live.LatestStreamArn === 'string' && live.LatestStreamArn.startsWith(`${live.TableArn}/stream/`)
      && live.StreamSpecification?.StreamEnabled === true && live.StreamSpecification.StreamViewType === 'NEW_AND_OLD_IMAGES'
      && JSON.stringify(live.KeySchema) === JSON.stringify([{ AttributeName: 'id', KeyType: 'HASH' }])
      && (!pinnedStreams[model] || live.LatestStreamArn === pinnedStreams[model]), `${model} current owned stream differs`);
    const actual = aws('lambda', 'get-event-source-mapping', '--uuid', resource.PhysicalResourceId);
    requireExtension(actual.UUID === resource.PhysicalResourceId && actual.FunctionArn === functionArn && actual.EventSourceArn === live.LatestStreamArn
      && actual.State === 'Enabled' && actual.StartingPosition === 'LATEST' && !actual.FilterCriteria?.Filters?.length
      && ['OK', 'No records processed'].includes(actual.LastProcessingResult) && actual.BatchSize === 25
      && actual.MaximumBatchingWindowInSeconds === 1 && actual.MaximumRetryAttempts === 10 && actual.MaximumRecordAgeInSeconds === 7200
      && JSON.stringify(actual.FunctionResponseTypes) === JSON.stringify(['ReportBatchItemFailures']), `${model} additive stream cursor is unhealthy or has changed scope`);
  }
  const actual = aws('scheduler', 'get-schedule', '--name', schedule.PhysicalResourceId, '--group-name', 'default');
  requireExtension(actual.Name === schedule.PhysicalResourceId && actual.State === 'ENABLED'
    && actual.ScheduleExpression === 'cron(* * * * ? *)' && actual.ScheduleExpressionTimezone === 'America/New_York'
    && JSON.stringify(actual.FlexibleTimeWindow) === JSON.stringify({ Mode: 'OFF' })
    && actual.Target?.Arn === functionArn && actual.Target.RoleArn === roleArn
    && Object.keys(actual.Target).sort().join(',') === 'Arn,RetryPolicy,RoleArn'
    && actual.Target.RetryPolicy?.MaximumEventAgeInSeconds === 86400 && actual.Target.RetryPolicy.MaximumRetryAttempts === 185,
    'additive account-list schedule timing/target/eligibility changed');
}
