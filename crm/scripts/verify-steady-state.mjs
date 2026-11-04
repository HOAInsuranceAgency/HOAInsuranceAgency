import { createHash } from "node:crypto";

/** Fresh read-only checks of the retained backend before every deployment. */
export function verifySteadyState(namespace, contract, aws) {
  const canonical = value => JSON.stringify(value, function (key, item) {
    return item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item;
  });
  const need = (ok, reason) => { if (!ok) throw new Error(`HOA steady-state live guard: ${reason}`); };
  need(namespace?.branchName === contract.backendBranch && namespace?.backend?.stackArn === contract.backendRoot,
    "existing backend root differs; replacement creation is prohibited");
  if (contract.backendBranch === "staging") {
    need(namespace.enableAutoBuild === false && namespace.enablePullRequestPreview !== true,
      "staging backend namespace must remain dormant");
  }
  const root = aws("cloudformation", "describe-stacks", "--stack-name", contract.backendRoot).Stacks;
  need(root.length === 1 && root[0].StackId === contract.backendRoot
    // A successful update rollback is a stable prior deployment. Admit a
    // retry only after all the same identity, cursor and schedule checks below.
    && ["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"].includes(root[0].StackStatus)
    && root[0].EnableTerminationProtection === true, "backend is unstable or unprotected");
  const inventory = [], seen = new Set();
  const collect = stack => {
    need(stack.startsWith(`arn:aws:cloudformation:${contract.region}:${contract.account}:stack/`)
      && !seen.has(stack) && seen.size < 100, "foreign or cyclic stack inventory");
    seen.add(stack);
    for (const r of aws("cloudformation", "list-stack-resources", "--stack-name", stack).StackResourceSummaries) {
      if (r.ResourceStatus === "DELETE_COMPLETE") continue;
      need(["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(r.ResourceStatus)
        || r.ResourceType === "AWS::CloudFormation::Stack" && r.ResourceStatus === "UPDATE_ROLLBACK_COMPLETE",
      "resource update is not complete");
      inventory.push({ ...r, stack });
      if (r.ResourceType === "AWS::CloudFormation::Stack") collect(r.PhysicalResourceId);
    }
  };
  collect(contract.backendRoot);
  // Preserve the original cutover inventory byte for byte. The broker-fee
  // feature may add exactly one separately protected, deterministically named
  // ledger; that exception never permits replacing an original resource.
  const ledgerName = `${contract.backendRoot.split('/')[1]}-broker-fees`;
  const ledgers = inventory.filter(r => r.ResourceType === "AWS::DynamoDB::Table"
    && /^BrokerFeeLedger[A-F0-9]{8}$/.test(r.LogicalResourceId)
    && r.PhysicalResourceId === ledgerName);
  need(ledgers.length <= 1, "more than one approved broker fee ledger exists");
  const stateful = inventory.filter(r => contract.statefulTypes.includes(r.ResourceType) && !ledgers.includes(r))
    .map(r => [r.stack, r.LogicalResourceId, r.ResourceType, r.PhysicalResourceId]);
  // Ordinary lexical order is shared with the checked-in canonical inventory.
  stateful.sort((a,b) => { for (let i=0;i<a.length;i++) { if(a[i]!==b[i]) return a[i]<b[i]?-1:1; } return 0; });
  need(stateful.length === 57 && contract.statefulCount === 57
    && createHash("sha256").update(JSON.stringify(stateful)).digest("hex") === contract.statefulInventorySha256,
    "stateful physical identities differ");
  if (ledgers.length) {
    const ledger = aws("dynamodb", "describe-table", "--table-name", ledgerName).Table;
    need(ledger?.TableName === ledgerName
      && ledger.TableArn === `arn:aws:dynamodb:${contract.region}:${contract.account}:table/${ledgerName}`
      && ledger.TableStatus === "ACTIVE" && ledger.DeletionProtectionEnabled === true,
      "broker fee ledger identity, readiness or deletion protection differs");
    need(canonical(ledger.KeySchema) === canonical([{ AttributeName: "id", KeyType: "HASH" }])
      && ledger.AttributeDefinitions?.length === 4
      && ["id", "accountId", "kind", "pending"].every(name => ledger.AttributeDefinitions.some(a => a.AttributeName === name && a.AttributeType === "S")),
      "broker fee ledger key definition differs");
    const expectedIndexes = { account: "accountId", kind: "kind", pending: "pending" };
    need(ledger.GlobalSecondaryIndexes?.length === 3
      && Object.entries(expectedIndexes).every(([name, key]) => {
        const index = ledger.GlobalSecondaryIndexes.find(i => i.IndexName === name);
        return index?.IndexStatus === "ACTIVE" && index.Projection?.ProjectionType === "ALL"
          && !index.Projection.NonKeyAttributes?.length && index.KeySchema?.length === 2
          && index.KeySchema.some(k => k.AttributeName === key && k.KeyType === "HASH")
          && index.KeySchema.some(k => k.AttributeName === "id" && k.KeyType === "RANGE");
      }), "broker fee ledger indexes differ");
  }
  const mappings = inventory.filter(r => r.ResourceType === "AWS::Lambda::EventSourceMapping");
  need(mappings.length === 22 && contract.mappings.length === 22 && new Set(contract.mappings.map(m=>m.uuid)).size === 22,
    "exact existing cursor inventory required");
  for (const expected of contract.mappings) {
    need(mappings.some(r => r.LogicalResourceId === expected.logical && r.PhysicalResourceId === expected.uuid)
      && expected.logical.endsWith("MigrationLiveV1"), "post-copy cursor identity changed");
    const actual = aws("lambda", "get-event-source-mapping", "--uuid", expected.uuid);
    need(actual.UUID === expected.uuid && actual.FunctionArn === expected.functionArn && actual.EventSourceArn === expected.streamArn
      && actual.State === "Enabled" && actual.StartingPosition === "LATEST"
      && !actual.FilterCriteria?.Filters?.length && ["OK", "No records processed"].includes(actual.LastProcessingResult),
      "existing stream cursor is not healthy or has changed scope");
  }
  const schedules = inventory.filter(r => r.ResourceType === "AWS::Scheduler::Schedule");
  need(schedules.length === 8 && contract.schedules.length === 8, "exact eight schedules required");
  for (const expected of contract.schedules) {
    need(schedules.some(r => r.LogicalResourceId === expected.logical && r.PhysicalResourceId === expected.name), "schedule identity changed");
    const actual = aws("scheduler", "get-schedule", "--name", expected.name, "--group-name", "default");
    const expectedState = contract.backendBranch === "staging" ? expected.state : "ENABLED";
    need(["ENABLED", "DISABLED"].includes(expectedState)
      && actual.Name === expected.name && actual.State === expectedState && expected.state === expectedState
      && actual.Target?.Arn === expected.functionArn && canonical(actual.Target) === canonical(expected.target)
      && actual.ScheduleExpression === expected.scheduleExpression
      && actual.ScheduleExpressionTimezone === expected.scheduleExpressionTimezone
      && JSON.stringify(actual.FlexibleTimeWindow) === JSON.stringify(expected.flexibleTimeWindow), "schedule timing/target/eligibility changed");
  }
}
