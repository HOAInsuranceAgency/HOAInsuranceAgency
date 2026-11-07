import { describe, expect, it } from 'vitest';
import contract from '../../amplify/steady-state-main.json';
import stagingContract from '../../amplify/steady-state-staging.json';
import { fixture, type Resource } from './fixtures/steadyStateBackend';
// Deployment preflight runs without npm dependencies on Amplify.
// @ts-expect-error JavaScript deployment-only verifier
import { verifySteadyState } from '../../scripts/verify-steady-state.mjs';
// @ts-expect-error JavaScript deployment-only allowlist
import { ACCOUNT_LIST_STAGING_EXTENSION } from '../../scripts/steady-state-account-list.mjs';


describe('narrow additive account-list steady-state admission', () => {
  it.each([false, true])('admits exactly one derived table, six current source mappings and one worker schedule while checking all original controls (staging=%s)', staging => {
    const f = fixture('', staging); expect(() => verifySteadyState(f.namespace, f.c, f.aws)).not.toThrow();
    expect(f.calls.filter(call => call[1] === 'get-event-source-mapping')).toHaveLength(28);
    expect(f.calls.filter(call => call[1] === 'get-schedule')).toHaveLength(staging ? 10 : 9);
    expect(f.calls.filter(call => call[1] === 'describe-table')).toHaveLength(7);
    expect(f.calls.every(call => ['describe-stacks', 'list-stack-resources', 'get-event-source-mapping', 'get-schedule', 'describe-table'].includes(call[1]))).toBe(true);
    expect(contract.statefulCount).toBe(57); expect(contract.mappings).toHaveLength(22); expect(contract.schedules).toHaveLength(8);
  });
  it.each([false, true])('admits both independently protected additions without changing the original inventory (staging=%s)', staging => {
    const f = fixture('', staging, true);
    expect(() => verifySteadyState(f.namespace, f.c, f.aws)).not.toThrow();
    expect(f.calls.filter(call => call[1] === 'get-event-source-mapping')).toHaveLength(28);
    expect(f.calls.filter(call => call[1] === 'get-schedule')).toHaveLength(staging ? 10 : 9);
    expect(f.calls.filter(call => call[1] === 'describe-table')).toHaveLength(8);
  });
  it.each(['unprotected-ledger', 'extra-table', 'old-stateful-change', 'old-cursor-change', 'old-schedule-change', 'foreign-stream', 'schedule-input'])(
    'rejects %s when the ledger and account-list additions coexist', failure => {
      const f = fixture(failure, true, true);
      expect(() => verifySteadyState(f.namespace, f.c, f.aws)).toThrow();
    },
  );
  it.each(['missing-table', 'missing-mapping', 'missing-schedule', 'missing-worker', 'wrong-type', 'duplicate-id', 'extra-table', 'extra-mapping', 'extra-schedule', 'old-stateful-change', 'old-cursor-change', 'old-schedule-change', 'foreign-table-stack', 'foreign-worker-stack', 'private-schema', 'foreign-source', 'source-generation', 'source-view', 'foreign-function', 'foreign-stream', 'disabled-mapping', 'replay', 'mapping-errors', 'batch-size', 'mapping-filter', 'disabled-schedule', 'schedule-timing', 'foreign-role', 'schedule-input'])(
    'rejects %s without broadening the original inventory contract', failure => {
      const f = fixture(failure); expect(() => verifySteadyState(f.namespace, f.c, f.aws)).toThrow();
    },
  );
  it.each(['missing-table', 'missing-mapping', 'extra-table', 'extra-mapping', 'extra-schedule', 'old-stateful-change', 'old-cursor-change', 'old-schedule-change', 'foreign-source', 'foreign-stream', 'foreign-function', 'source-generation', 'replay', 'schedule-input'])(
    'rejects staging %s while preserving the original staging contract', failure => {
      const f = fixture(failure, true); expect(() => verifySteadyState(f.namespace, f.c, f.aws)).toThrow();
    },
  );
  it('keeps the staging namespace dormant and its original weekly marketing schedule disabled', () => {
    const f = fixture('', true);
    expect(() => verifySteadyState({ ...f.namespace, enableAutoBuild: true }, f.c, f.aws)).toThrow();
    expect(() => verifySteadyState({ ...f.namespace, enablePullRequestPreview: true }, f.c, f.aws)).toThrow();
    const marketing = f.c.schedules.find(schedule => schedule.state === 'DISABLED')!;
    const reads = (...args: string[]) => args[1] === 'get-schedule' && args[3] === marketing.name
      ? { ...(f.aws(...args) as object), State: 'ENABLED' } : f.aws(...args);
    expect(() => verifySteadyState(f.namespace, f.c, reads)).toThrow();
  });
  it.each([false, true])('rejects swapping root, branch or runtime scope after adding the extension (staging=%s)', staging => {
    const f = fixture('', staging), foreign = staging ? contract : stagingContract;
    for (const change of [{ backendRoot: foreign.backendRoot }, { branch: foreign.branch }, { runtimeBranch: foreign.runtimeBranch }, { backendBranch: foreign.backendBranch }]) {
      expect(() => verifySteadyState({ ...f.namespace, branchName: change.backendBranch ?? f.namespace.branchName, backend: { stackArn: change.backendRoot ?? f.c.backendRoot } }, { ...f.c, ...change }, f.aws)).toThrow();
    }
  });
});

describe('required retained staging schedule additions', () => {
  it('admits the enabled account-list and disabled commission schedules without changing the original eight', () => {
    const f = fixture('', true);
    const receipt = verifySteadyState(f.namespace, f.c, f.aws);
    expect(receipt).toMatchObject({ originalScheduleCount: 8, observedScheduleCount: 10,
      accountListExtensionPresent: true, stagingCommissionSchedulePresent: true });
    expect(f.commissionSchedule!.State).toBe('DISABLED');
    expect(f.c.schedules).toEqual(stagingContract.schedules);
    expect(f.calls.filter(call => call[1] === 'get-schedule')).toHaveLength(10);
  });
  it.each(['deleted', 'undefined', 'false', 'null', 'missing account-list requirement', 'false account-list requirement'])(
    'rejects a %s staging addition contract instead of treating it as optional', failure => {
      const f = fixture('', true);
      if (failure === 'deleted') Reflect.deleteProperty(f.c, 'stagingScheduleExtension');
      if (failure === 'undefined') Object.assign(f.c, { stagingScheduleExtension: undefined });
      if (failure === 'false') Object.assign(f.c, { stagingScheduleExtension: false });
      if (failure === 'null') Object.assign(f.c, { stagingScheduleExtension: null });
      if (failure === 'missing account-list requirement') {
        Reflect.deleteProperty((f.c as typeof stagingContract).stagingScheduleExtension, 'requireAccountList');
      }
      if (failure === 'false account-list requirement') {
        Object.assign((f.c as typeof stagingContract).stagingScheduleExtension, { requireAccountList: false });
      }
      expect(() => verifySteadyState(f.namespace, f.c, f.aws)).toThrow(/addition contract/);
    },
  );
  it('rejects complete removal of the already deployed account-list extension', () => {
    const f = fixture('', true);
    for (const logical of [ACCOUNT_LIST_STAGING_EXTENSION.table, ACCOUNT_LIST_STAGING_EXTENSION.workerStack]) {
      f.root.splice(f.root.findIndex(resource => resource.LogicalResourceId === logical), 1);
    }
    expect(() => verifySteadyState(f.namespace, f.c, f.aws)).toThrow();
  });
  it.each(['enabled', 'target', 'role', 'input', 'dead-letter queue', 'retry age', 'retry count', 'timing', 'timezone', 'flexible window'])(
    'rejects commission schedule %s drift', failure => {
      const f = fixture('', true), schedule = f.commissionSchedule!;
      if (failure === 'enabled') schedule.State = 'ENABLED';
      if (failure === 'target') schedule.Target.Arn += '-other';
      if (failure === 'role') schedule.Target.RoleArn += '-other';
      if (failure === 'input') schedule.Target.Input = '{"unexpected":true}';
      if (failure === 'dead-letter queue') schedule.Target.DeadLetterConfig.Arn += '-other';
      if (failure === 'retry age') schedule.Target.RetryPolicy.MaximumEventAgeInSeconds++;
      if (failure === 'retry count') schedule.Target.RetryPolicy.MaximumRetryAttempts++;
      if (failure === 'timing') schedule.ScheduleExpression = 'rate(1 hour)';
      if (failure === 'timezone') schedule.ScheduleExpressionTimezone = 'UTC';
      if (failure === 'flexible window') Object.assign(schedule.FlexibleTimeWindow, { Mode: 'FLEXIBLE', MaximumWindowInMinutes: 1 });
      expect(() => verifySteadyState(f.namespace, f.c, f.aws)).toThrow(/commission payroll schedule/);
    },
  );
  it.each(['missing', 'duplicate', 'wrong name', 'wrong logical identity', 'wrong resource type', 'extra schedule', 'missing owning stack'])(
    'rejects a %s commission resource', failure => {
      const f = fixture('', true), resource = f.commissionResources[0];
      if (failure === 'missing') f.commissionResources.splice(0, 1);
      if (failure === 'duplicate') f.commissionResources.push({ ...resource });
      if (failure === 'wrong name') resource.PhysicalResourceId += '-other';
      if (failure === 'wrong logical identity') resource.LogicalResourceId = 'UnreviewedCommissionSchedule';
      if (failure === 'wrong resource type') resource.ResourceType = 'AWS::Events::Rule';
      if (failure === 'extra schedule') f.commissionResources.push({ ...resource, LogicalResourceId: 'UnreviewedSchedule', PhysicalResourceId: 'unreviewed-schedule' });
      if (failure === 'missing owning stack') f.root.splice(f.root.findIndex(row => row.LogicalResourceId === 'commissionpayrollC11FCD08'), 1);
      expect(() => verifySteadyState(f.namespace, f.c, f.aws)).toThrow(/commission payroll schedule|ten staging schedules/);
    },
  );
  it('rejects moving the commission schedule into another retained stack', () => {
    const f = fixture('', true);
    f.root.push(f.commissionResources.splice(0, 1)[0]);
    expect(() => verifySteadyState(f.namespace, f.c, f.aws)).toThrow(/owning stack/);
  });
  it('rejects replacing the owning nested stack while retaining the same schedule name', () => {
    const f = fixture('', true), expected = stagingContract.stagingScheduleExtension.commissionPayroll;
    const owner = f.root.find(resource => resource.PhysicalResourceId === expected.stackArn)!;
    owner.PhysicalResourceId += '-replacement';
    const reads = (...args: string[]) => args[1] === 'list-stack-resources' && args[3] === owner.PhysicalResourceId
      ? { StackResourceSummaries: f.commissionResources } : f.aws(...args);
    expect(() => verifySteadyState(f.namespace, f.c, reads)).toThrow(/owning stack/);
  });
});


describe('explicit retained staging rollback recovery', () => {
  const options = { recoverStagingRollback: true };
  function rolledBackReads(f: ReturnType<typeof fixture>, rootStatus = 'UPDATE_ROLLBACK_COMPLETE', resourceType = 'AWS::CloudFormation::Stack') {
    return (...args: string[]) => {
      const response = f.aws(...args) as { Stacks?: Record<string, unknown>[]; StackResourceSummaries?: Resource[] };
      if (args[1] === 'describe-stacks') return { Stacks: response.Stacks!.map(stack => ({ ...stack, StackStatus: rootStatus })) };
      if (args[1] === 'list-stack-resources' && args[3] === f.c.backendRoot) return { StackResourceSummaries: response.StackResourceSummaries!.map(resource =>
        resource.ResourceType === resourceType ? { ...resource, ResourceStatus: 'UPDATE_ROLLBACK_COMPLETE' } : resource) };
      return response;
    };
  }
  it('keeps the default guard strict for a fully rolled-back staging root', () => {
    const f = fixture('', true, true);
    expect(() => verifySteadyState(f.namespace, f.c, rolledBackReads(f))).toThrow(/unstable/);
  });
  it('records observed rollback statuses while checking both additions and every original control', () => {
    const f = fixture('', true, true);
    const receipt = verifySteadyState(f.namespace, f.c, rolledBackReads(f), options);
    expect(receipt).toMatchObject({ backendRoot: stagingContract.backendRoot, observedRootStatus: 'UPDATE_ROLLBACK_COMPLETE', stagingRollbackRecovery: true,
      originalStatefulCount: 57, originalStatefulInventorySha256: f.c.statefulInventorySha256, originalCursorCount: 22, originalScheduleCount: 8, accountListExtensionPresent: true, brokerFeeLedgerPresent: true });
    expect(receipt.observedRolledBackNestedStacks).toEqual([{ logicalId: ACCOUNT_LIST_STAGING_EXTENSION.workerStack,
      stackArn: `arn:aws:cloudformation:${f.c.region}:${f.c.account}:stack/account-list-owned/12345678`, observedStatus: 'UPDATE_ROLLBACK_COMPLETE' },
    { logicalId: 'commissionpayrollC11FCD08', stackArn: stagingContract.stagingScheduleExtension.commissionPayroll.stackArn,
      observedStatus: 'UPDATE_ROLLBACK_COMPLETE' }]);
    expect(f.calls.filter(call => call[1] === 'get-event-source-mapping')).toHaveLength(28);
    expect(f.calls.filter(call => call[1] === 'get-schedule')).toHaveLength(10);
    expect(f.calls.filter(call => call[1] === 'describe-table')).toHaveLength(8);
  });
  it.each(['UPDATE_ROLLBACK_FAILED', 'UPDATE_ROLLBACK_IN_PROGRESS', 'UPDATE_IN_PROGRESS', 'ROLLBACK_COMPLETE'])(
    'rejects an incomplete or different root status %s', status => {
      const f = fixture('', true); expect(() => verifySteadyState(f.namespace, f.c, rolledBackReads(f, status), options)).toThrow(/unstable/);
    },
  );
  it('rejects a rolled-back non-stack resource even in recovery mode', () => {
    const f = fixture('', true); expect(() => verifySteadyState(f.namespace, f.c, rolledBackReads(f, 'UPDATE_ROLLBACK_COMPLETE', 'AWS::DynamoDB::Table'), options)).toThrow(/resource update/);
  });
  it.each(['old-stateful-change', 'old-cursor-change', 'old-schedule-change', 'extra-table', 'extra-mapping', 'extra-schedule', 'unprotected-ledger', 'foreign-stream', 'schedule-input'])(
    'retains the existing rejection of %s during recovery', failure => {
      const f = fixture(failure, true, true); expect(() => verifySteadyState(f.namespace, f.c, rolledBackReads(f), options)).toThrow();
    },
  );
  it('rejects recovery for main or a different staging identity', () => {
    const main = fixture(); expect(() => verifySteadyState(main.namespace, main.c, main.aws, options)).toThrow(/restricted/);
    const f = fixture('', true);
    for (const delta of [{ backendRoot: f.c.backendRoot + '-other' }, { account: '637423611040' }, { branch: 'staging' }, { backendBranch: 'main' }, { runtimeBranch: 'main' }, { region: 'us-west-2' }, { crmApp: 'other' }]) {
      expect(() => verifySteadyState(f.namespace, { ...f.c, ...delta }, f.aws, options)).toThrow(/restricted/);
    }
  });
});
