const STAGING_ROOT = 'arn:aws:cloudformation:us-east-1:917680434255:stack/amplify-d1nuh9rw1hcuxo-staging-branch-3787a09124/eaa4dff0-d3d3-11f1-ab1d-0edee65f4629';
const STAGING_STACK = STAGING_ROOT.slice(0, STAGING_ROOT.lastIndexOf('/'));
const COMMISSION_SCHEDULE = 'CommissionPayrollScheduleFB5DD3E9';
const need = (ok, reason) => { if (!ok) throw new Error(`HOA steady-state staging schedules: ${reason}`); };
const canonical = value => JSON.stringify(value, function (key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item;
});

/** The deployed staging additions are mandatory. Only the commission schedule
 * leaves the original inventory here; the existing account-list verifier owns
 * its private table, six cursors, worker and enabled schedule without changes. */
export function stagingScheduleExtension(inventory, contract) {
  const staging = contract.backendBranch === 'staging' || contract.branch === 'codex-hoa-staging-migration'
    || contract.runtimeBranch === 'codex-hoa-staging-migration';
  if (!staging) {
    need(!Object.prototype.hasOwnProperty.call(contract, 'stagingScheduleExtension'), 'addition contract is staging-only');
    return { inventory, commission: null };
  }
  need(contract.account === '917680434255' && contract.region === 'us-east-1' && contract.crmApp === 'd1nuh9rw1hcuxo'
    && contract.branch === 'codex-hoa-staging-migration' && contract.backendBranch === 'staging'
    && contract.runtimeBranch === 'codex-hoa-staging-migration' && contract.backendRoot === STAGING_ROOT,
    'addition contract is bound to the exact retained staging backend');
  const addition = contract.stagingScheduleExtension;
  need(addition && typeof addition === 'object' && !Array.isArray(addition)
    && Object.keys(addition).sort().join(',') === 'commissionPayroll,requireAccountList,version'
    && addition.version === 1 && addition.requireAccountList === true, 'required staging addition contract is missing or invalid');
  const expected = addition.commissionPayroll;
  need(expected && expected.logical === COMMISSION_SCHEDULE && expected.state === 'DISABLED'
    && expected.scheduleExpression === 'cron(0 8-17 * * ? *)' && expected.scheduleExpressionTimezone === 'America/New_York'
    && canonical(expected.flexibleTimeWindow) === canonical({ Mode: 'OFF' })
    && typeof expected.name === 'string' && expected.name.length > 0
    && typeof expected.stackArn === 'string' && expected.stackArn.startsWith(`${STAGING_STACK}-commissionpayroll`)
    && typeof expected.functionArn === 'string' && expected.functionArn.startsWith('arn:aws:lambda:us-east-1:917680434255:function:amplify-d1nuh9rw1hcuxo-st-commissionpayrollworker')
    && expected.target?.Arn === expected.functionArn, 'commission payroll contract identity, timing or disabled state differs');
  const found = inventory.filter(row => row.LogicalResourceId === COMMISSION_SCHEDULE);
  need(found.length === 1 && found[0].ResourceType === 'AWS::Scheduler::Schedule'
    && found[0].PhysicalResourceId === expected.name && found[0].stack === expected.stackArn,
    'exact commission payroll schedule identity and owning stack required');
  need(inventory.filter(row => row.ResourceType === 'AWS::Scheduler::Schedule').length === 10,
    'exact ten staging schedules required');
  return { inventory: inventory.filter(row => row !== found[0]), commission: expected };
}

export function verifyStagingCommissionSchedule(expected, aws) {
  if (!expected) return;
  const actual = aws('scheduler', 'get-schedule', '--name', expected.name, '--group-name', 'default');
  need(actual.Name === expected.name && actual.State === 'DISABLED'
    && actual.Target?.Arn === expected.functionArn && canonical(actual.Target) === canonical(expected.target)
    && actual.ScheduleExpression === expected.scheduleExpression
    && actual.ScheduleExpressionTimezone === expected.scheduleExpressionTimezone
    && canonical(actual.FlexibleTimeWindow) === canonical(expected.flexibleTimeWindow),
    'commission payroll schedule timing, target or disabled state changed');
}
