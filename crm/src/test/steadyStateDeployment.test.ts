import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { assertSteadyState } from "../../amplify/steady-state.mjs";
import contract from "../../amplify/steady-state-main.json";
import stagingContract from "../../amplify/steady-state-staging.json";
// CI preflight is JavaScript so it can run before npm ci on Amplify.
// @ts-expect-error the deployment-only reader is exercised directly with a fake AWS boundary
import { verifySteadyState } from "../../scripts/verify-steady-state.mjs";

const env = {
  AWS_APP_ID: contract.crmApp, AWS_BRANCH: "main", HOA_DEPLOY_ACCOUNT_ID: contract.account,
  HOA_DEPLOYMENT_MODE: "steady-state", HOA_MIGRATION_AUTH: "true", HOA_MIGRATION_PREVIEW: "false",
  HOA_MIGRATION_STREAM_PHASE: "armed", HOA_MIGRATION_WORKERS_ENABLED: "true", HOA_MIGRATION_STREAM_PROBE_ENABLED: "false",
  HOA_MIGRATION_SCHEDULES_ENABLED: "true", HOA_TRANSACTIONAL_MAIL_RELEASE: "true", HOA_TRANSACTIONAL_MAIL_RECOVERY_ENABLED: "false",
  HOA_PREVIEW_ADMIN_LOGIN: "false", HOA_RESEND_PREVIEW_ENABLED: "false", HOA_MIGRATION_PENDING_CUTOFF: contract.pendingCutoff,
  HOA_MIGRATION_PENDING_ACCOUNT: contract.account, HOA_PREVIEW_ADMIN_USER_POOL_ID: contract.pool, HOA_PREVIEW_ADMIN_CLIENT_ID: contract.client,
  VITE_HOA_MIGRATION_PREVIEW: "false", VITE_HOA_MIGRATION_AUTH: "true", VITE_HOA_PREVIEW_ADMIN_LOGIN: "false",
};
describe("completed HOA main deployment", () => {
  it("uses permanent cutover provenance without re-aging a historical RELEASE", () => {
    expect(() => assertSteadyState({ ...env, HOA_MIGRATION_RELEASE_RECEIPT: '{"reviewedAt":"2026-11-02T02:19:47Z"}' }, contract)).not.toThrow();
    expect(contract.pendingCutoff).toBe("2026-11-01T22:17:39.654Z");
    expect(contract.runtimeBranch).toBe("codex-hoa-account-migration");
  });
  it.each([
    { HOA_DEPLOY_ACCOUNT_ID: "637423611040" }, { AWS_APP_ID: "d2d4g940z91vj4" }, { AWS_BRANCH: "staging" },
    { HOA_DEPLOYMENT_MODE: "" }, { HOA_MIGRATION_PENDING_CUTOFF: "" }, { HOA_MIGRATION_PENDING_CUTOFF: "2026-11-02T00:00:00.000Z" },
    { HOA_PREVIEW_ADMIN_USER_POOL_ID: "wrong" }, { HOA_PREVIEW_ADMIN_CLIENT_ID: "wrong" },
    { HOA_MIGRATION_SCHEDULES_ENABLED: "false" }, { HOA_MIGRATION_STREAM_PHASE: "quarantine" },
    { HOA_TRANSACTIONAL_MAIL_RECOVERY_ENABLED: "true" }, { HOA_MIGRATION_STREAM_PROBE_ENABLED: "true" },
    { HOA_PREVIEW_ADMIN_LOGIN_EXPIRES_AT: "2027-01-01T00:00:00Z" }, { HOA_MIGRATION_PREPARE_RECEIPT: "old" },
  ])("rejects a foreign or unsafe main configuration %j", delta => expect(() => assertSteadyState({ ...env, ...delta }, contract)).toThrow());
  it("allows only the destination website's production binding", () => {
    const web = { ...env, AWS_APP_ID: contract.webApp, PUBLIC_HOA_MIGRATION_PREVIEW: "false", PUBLIC_ANALYTICS_DISABLED: "false", PUBLIC_CRM_API_URL: contract.graphqlUrl };
    expect(() => assertSteadyState(web, contract)).not.toThrow();
    expect(() => assertSteadyState({ ...web, PUBLIC_CRM_API_URL: "https://source.invalid/graphql" }, contract)).toThrow();
  });
  it("retains the current auth/mail/pending runtime identity without changing handlers", () => {
    const config = readFileSync("amplify/migration-config.ts", "utf8");
    expect(config).toContain('"runtimeBranch" in retained ? retained.runtimeBranch : branch');
    expect(readFileSync("amplify/migration-preview.ts", "utf8")).toContain('addEnvironment("HOA_MIGRATION_BRANCH", migrationRuntimeBranch)');
    expect(readFileSync("amplify/backend.ts", "utf8")).toContain("backend.stack.terminationProtection = true");
  });
});

function liveFixture(failure = "", source = contract) {
  const c = structuredClone(source);
  const stateful = Array.from({ length: 57 }, (_, i) => [c.backendRoot, `State${String(i).padStart(2,"0")}`, c.statefulTypes[0], `existing-${i}`]);
  c.statefulInventorySha256 = createHash("sha256").update(JSON.stringify(stateful)).digest("hex");
  const resources = [
    ...stateful.map(([, logical, type, physical]) => ({ LogicalResourceId: logical, ResourceType: type, PhysicalResourceId: physical })),
    ...c.mappings.map(m => ({ LogicalResourceId: m.logical, ResourceType: "AWS::Lambda::EventSourceMapping", PhysicalResourceId: m.uuid })),
    ...c.schedules.map(s => ({ LogicalResourceId: s.logical, ResourceType: "AWS::Scheduler::Schedule", PhysicalResourceId: s.name })),
  ].map(r => ({ ...r, ResourceStatus: "CREATE_COMPLETE" }));
  if (failure === "identity") resources[0].PhysicalResourceId = "replacement";
  if (failure === "extra") resources.push({ ...resources[57], PhysicalResourceId: "old-cursor" });
  const calls: string[][] = [];
  const aws = (...a: string[]) => {
    calls.push(a);
    if (a[1] === "describe-stacks") return { Stacks: [{ StackId: c.backendRoot, StackStatus: failure === "updating" ? "UPDATE_IN_PROGRESS" : "UPDATE_COMPLETE", EnableTerminationProtection: failure !== "unprotected" }] };
    if (a[1] === "list-stack-resources") return { StackResourceSummaries: resources };
    if (a[1] === "get-event-source-mapping") {
      const m = c.mappings.find(x => x.uuid === a[3])!;
      return { UUID: m.uuid, FunctionArn: m.functionArn, EventSourceArn: failure === "stream" ? "different" : m.streamArn,
        State: failure === "disabled" ? "Disabled" : "Enabled", StartingPosition: failure === "replay" ? "TRIM_HORIZON" : "LATEST",
        LastProcessingResult: failure === "errors" ? "PROBLEM: failure" : "OK", ...(failure === "filter" ? { FilterCriteria: { Filters: [{ Pattern: "{}" }] } } : {}) };
    }
    if (a[1] === "get-schedule") {
      const s = c.schedules.find(x => x.name === a[3])!;
      return { Name: s.name, State: failure === "schedule" ? s.state === "ENABLED" ? "DISABLED" : "ENABLED" : s.state, Target: { ...s.target, ...(failure === "target-input" ? { Input: "{\"unexpected\":true}" } : {}) }, ScheduleExpression: s.scheduleExpression, ScheduleExpressionTimezone: s.scheduleExpressionTimezone, FlexibleTimeWindow: s.flexibleTimeWindow };
    }
    throw new Error("Unexpected AWS operation");
  };
  return { c, aws, calls, namespace: { branchName: c.backendBranch, enableAutoBuild: false, enablePullRequestPreview: false, backend: { stackArn: failure === "root" ? "wrong" : c.backendRoot } } };
}
describe("read-only existing backend admission", () => {
  it("requires all57 stateful identities,22 existing cursors and8 enabled main schedules", () => {
    const f = liveFixture(); verifySteadyState(f.namespace, f.c, f.aws);
    expect(f.calls.filter(a => a[1] === "get-event-source-mapping")).toHaveLength(22);
    expect(f.calls.filter(a => a[1] === "get-schedule")).toHaveLength(8);
    expect(f.calls.every(a => ["describe-stacks", "list-stack-resources", "get-event-source-mapping", "get-schedule"].includes(a[1]))).toBe(true);
  });
  it.each(["root", "unprotected", "updating", "identity", "extra", "stream", "disabled", "replay", "errors", "filter", "schedule", "target-input"])("rejects %s before a deploy", failure => {
    const f = liveFixture(failure); expect(() => verifySteadyState(f.namespace, f.c, f.aws)).toThrow();
  });
});

describe("completed HOA staging deployment", () => {
  const stageEnv = { ...env, AWS_BRANCH: stagingContract.branch,
    HOA_MIGRATION_PENDING_CUTOFF: stagingContract.pendingCutoff,
    HOA_PREVIEW_ADMIN_USER_POOL_ID: stagingContract.pool, HOA_PREVIEW_ADMIN_CLIENT_ID: stagingContract.client };
  it("admits the retained staging backend using its historical receipt without renewing the cutover", () => {
    expect(() => assertSteadyState(stageEnv, stagingContract)).not.toThrow();
    expect(stagingContract.pendingCutoff).toBe("2026-11-01T22:17:39.654Z");
    expect(stagingContract.backendBranch).toBe("staging");
    expect(stagingContract.schedules.filter(s => s.state === "ENABLED")).toHaveLength(7);
    expect(stagingContract.schedules.filter(s => s.state === "DISABLED").map(s => s.logical)).toEqual(["WeeklyMarketingReportSchedule6899ACFF"]);
    const f = liveFixture("", stagingContract); verifySteadyState(f.namespace, f.c, f.aws);
    expect(f.calls.every(a => ["describe-stacks", "list-stack-resources", "get-event-source-mapping", "get-schedule"].includes(a[1]))).toBe(true);
  });
  it.each([
    { AWS_BRANCH: "staging" }, { AWS_BRANCH: "main" }, { HOA_DEPLOYMENT_MODE: "" },
    { HOA_DEPLOY_ACCOUNT_ID: "637423611040" }, { HOA_PREVIEW_ADMIN_USER_POOL_ID: contract.pool },
    { HOA_PREVIEW_ADMIN_CLIENT_ID: contract.client }, { HOA_MIGRATION_PREVIEW: "true" },
    { HOA_MIGRATION_STREAM_PHASE: "quarantine" }, { HOA_MIGRATION_SCHEDULES_ENABLED: "false" },
    { HOA_MIGRATION_PENDING_CUTOFF: "2026-11-02T00:00:00.000Z" }, { HOA_MIGRATION_STREAM_PROBE_TOKEN: "temporary" },
  ])("rejects a foreign or unsafe staging configuration %j", delta => {
    expect(() => assertSteadyState({ ...stageEnv, ...delta }, stagingContract)).toThrow();
  });
  it("rejects a staging contract with a foreign root, auth or runtime identity", () => {
    for (const delta of [{ backendRoot: contract.backendRoot }, { pool: contract.pool }, { client: contract.client },
      { graphqlUrl: contract.graphqlUrl }, { runtimeBranch: "main" }, { backendBranch: "main" }]) {
      expect(() => assertSteadyState(stageEnv, { ...stagingContract, ...delta })).toThrow();
    }
    expect(() => assertSteadyState(stageEnv, contract)).toThrow();
    expect(() => assertSteadyState(env, stagingContract)).toThrow();
  });
  it.each(["root", "unprotected", "updating", "identity", "extra", "stream", "disabled", "replay", "errors", "filter", "schedule", "target-input"])("rejects staging %s before deploy", failure => {
    const f = liveFixture(failure, stagingContract); expect(() => verifySteadyState(f.namespace, f.c, f.aws)).toThrow();
  });
  it("keeps the namespace dormant and preserves the disabled staging marketing schedule", () => {
    const f = liveFixture("", stagingContract);
    expect(() => verifySteadyState({ ...f.namespace, enableAutoBuild: true }, f.c, f.aws)).toThrow();
    expect(() => verifySteadyState({ ...f.namespace, enablePullRequestPreview: true }, f.c, f.aws)).toThrow();
    const marketing = f.c.schedules.find(s => s.state === "DISABLED")!;
    const read = (...args: string[]) => args[1] === "get-schedule" && args[3] === marketing.name
      ? { ...f.aws(...args), State: "ENABLED" } : f.aws(...args);
    expect(() => verifySteadyState(f.namespace, f.c, read)).toThrow();
  });
  it("does not weaken main's requirement that all eight schedules remain enabled", () => {
    const f = liveFixture(); f.c.schedules[0].state = "DISABLED";
    expect(() => verifySteadyState(f.namespace, f.c, f.aws)).toThrow();
  });
});
