import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "hoa-guard-test-"));
const command = join(dir, "aws");
writeFileSync(command, `#!${process.execPath}\nconst a=process.argv.slice(2), bad=process.env.HOA_TEST_FAILURE;
if(a[0]==='sts') console.log(bad==='account'?'637423611040':'917680434255');
else if(a[0]==='amplify') {const namespace=process.env.AWS_BRANCH==='codex-hoa-staging-migration'?'staging':'main';if(a[a.indexOf('--branch-name')+1]!==namespace)process.exit(5);console.log(JSON.stringify({branch:{branchName:bad==='namespace'?'codex-hoa-account-migration':namespace,enableAutoBuild:bad==='autobuild',enablePullRequestPreview:false,backend:{stackArn:'arn:aws:cloudformation:us-east-1:917680434255:stack/amplify-d1nuh9rw1hcuxo-'+namespace+'-branch-fixture/id'}}}));}
else if(a[0]==='cloudformation') console.log(JSON.stringify({StackResourceSummaries:Array.from({length:22},(_,i)=>({ResourceType:'AWS::Lambda::EventSourceMapping',ResourceStatus:'CREATE_COMPLETE',LogicalResourceId:'Stream'+i+(bad==='old'?'':'MigrationLiveV1'),PhysicalResourceId:'uuid-'+i}))}));
else if(a[0]==='lambda') console.log(JSON.stringify({State:bad==='disabled'?'Disabled':'Enabled',StartingPosition:bad==='replay'?'TRIM_HORIZON':'LATEST',LastProcessingResult:bad==='polling'?'':'No records processed',LastModified:new Date(Date.now()-(bad==='recent'?1000:600000)).toISOString()}));
else process.exit(4);\n`);
chmodSync(command, 0o755);
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const receipt = {
  schema: 1, account: "917680434255", app: "d1nuh9rw1hcuxo", branch: "codex-hoa-account-migration", backendBranch: "main",
  sourceQuiescedAt: new Date(Date.now()-600000).toISOString(), finalSyncCompletedAt: new Date(Date.now()-540000).toISOString(),
  pendingWorkReconciledAt: new Date(Date.now()-480000).toISOString(), pollingVerifiedAt: new Date(Date.now()-420000).toISOString(),
  reviewedAt: new Date(Date.now()-360000).toISOString(), reviewedBy: "test fixture", finalSyncReceiptSha256: "a".repeat(64), mappingUuids: Array.from({length:22},(_,i)=>`uuid-${i}`),
};
const baseline = {
  ...process.env, PATH: `${dir}:${process.env.PATH}`, AWS_APP_ID: "d1nuh9rw1hcuxo", AWS_BRANCH: "codex-hoa-account-migration",
  HOA_MIGRATION_RELEASE_RECEIPT: JSON.stringify(receipt),
  HOA_DEPLOY_ACCOUNT_ID: "917680434255", HOA_MIGRATION_AUTH: "true", HOA_MIGRATION_PREVIEW: "true",
  HOA_MIGRATION_STREAM_PHASE: "quarantine", VITE_HOA_MIGRATION_PREVIEW: "true", PUBLIC_GOOGLE_PLACES_KEY: "", VITE_GOOGLE_PLACES_KEY: "",
};
function run(env: Record<string, string | undefined> = {}) {
  return execFileSync(process.execPath, [resolve("scripts/assert-migration-destination.mjs")], { env: { ...baseline, ...env }, stdio: "pipe", encoding: "utf8" });
}
describe("destination deployment and replay barrier", () => {
  it("accepts the isolated quarantine build", () => expect(run()).toContain("read-only preview"));
  it.each([
    { HOA_TEST_FAILURE: "account" },
    { HOA_TEST_FAILURE: "namespace" },
    { HOA_TEST_FAILURE: "autobuild" },
    { AWS_APP_ID: "d2d4g940z91vj4" },
    { AWS_BRANCH: "main" },
    { VITE_GOOGLE_PLACES_KEY: "provider-key" },
    { VITE_HOA_MIGRATION_PREVIEW: "false" },
  ])("rejects a wrong destination or missing frontend fence: %j", env => expect(() => run(env)).toThrow());
  it("uses the staging namespace for its separate hosted preview", () => expect(run({ AWS_BRANCH: "codex-hoa-staging-migration" })).toContain("staging"));
  it("rejects release directly from quarantine", () => expect(() => run({ HOA_MIGRATION_PREVIEW: "false" })).toThrow());
  it.each(["old", "disabled", "replay", "polling", "recent"])("rejects a release while stream state is %s", failure => {
    expect(() => run({ HOA_MIGRATION_PREVIEW: "false", HOA_MIGRATION_STREAM_PHASE: "armed", HOA_TEST_FAILURE: failure })).toThrow();
  });
  it("rejects release without a reviewed final-copy receipt", () => expect(() => run({ HOA_MIGRATION_PREVIEW: "false", HOA_MIGRATION_STREAM_PHASE: "armed", HOA_MIGRATION_RELEASE_RECEIPT: "" })).toThrow());
  it("rejects cursor UUIDs different from the reviewed receipt", () => expect(() => run({ HOA_MIGRATION_PREVIEW: "false", HOA_MIGRATION_STREAM_PHASE: "armed", HOA_MIGRATION_RELEASE_RECEIPT: JSON.stringify({ ...receipt, mappingUuids: receipt.mappingUuids.map(x => `${x}-old`) }) })).toThrow());
  it("requires all 22 already-existing fresh cursors before release", () => {
    expect(run({ HOA_MIGRATION_PREVIEW: "false", HOA_MIGRATION_STREAM_PHASE: "armed" })).toContain("release");
  });
});
