import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "hoa-guard-test-"));
const command = join(dir, "aws");
const preload = join(dir, "capture-fake-aws.mjs");
writeFileSync(command, `#!${process.execPath}\nconst a=process.argv.slice(2), bad=process.env.HOA_TEST_FAILURE;
if(a[0]==='sts') console.log(bad==='account'?'637423611040':'917680434255');
else if(a[0]==='amplify') {const namespace=process.env.AWS_BRANCH==='codex-hoa-staging-migration'?'staging':'main';if(a[a.indexOf('--branch-name')+1]!==namespace)process.exit(5);console.log(JSON.stringify({branch:{branchName:bad==='namespace'?'codex-hoa-account-migration':namespace,enableAutoBuild:bad==='autobuild',enablePullRequestPreview:false,backend:{stackArn:'arn:aws:cloudformation:us-east-1:917680434255:stack/amplify-d1nuh9rw1hcuxo-'+namespace+'-branch-fixture/id'}}}));}
else if(a[0]==='cloudformation') console.log(JSON.stringify({StackResourceSummaries:Array.from({length:22},(_,i)=>({ResourceType:'AWS::Lambda::EventSourceMapping',ResourceStatus:'CREATE_COMPLETE',LogicalResourceId:'Stream'+i+(bad==='old'?'':'MigrationLiveV1'),PhysicalResourceId:'uuid-'+i}))}));
else if(a[0]==='lambda') console.log(JSON.stringify({State:bad==='disabled'?'Disabled':'Enabled',StartingPosition:bad==='replay'?'TRIM_HORIZON':'LATEST',LastProcessingResult:bad==='polling'?'':'No records processed',LastModified:new Date(Date.now()-(bad==='recent'?1000:600000)).toISOString()}));
else {console.error('Unsupported fake AWS operation');process.exit(4);}\n`);
chmodSync(command, 0o755);
// Only the test's real fake-AWS executable is launched. File descriptors avoid
// the sandbox's restricted socket-backed pipe introspection in nested Node.
writeFileSync(preload, `
import childProcess from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const nativeExec = childProcess.execFileSync;
const fakeAws = ${JSON.stringify(command)}, directory = ${JSON.stringify(dir)};
let sequence = 0;
childProcess.execFileSync = (file, args, options = {}) => {
  if (file !== 'aws' && file !== fakeAws) throw new Error('Unexpected deployment-guard test command: ' + file);
  const name = 'aws-' + process.pid + '-' + sequence++;
  const stdout = join(directory, name + '.stdout'), stderr = join(directory, name + '.stderr');
  const descriptors = [];
  let failure;
  try {
    descriptors.push(openSync(stdout, 'wx', 0o600));
    descriptors.push(openSync(stderr, 'wx', 0o600));
    nativeExec(fakeAws, args, { ...options, stdio: ['ignore', ...descriptors] });
  } catch (error) { failure = error; }
  finally { descriptors.forEach(closeSync); }
  const decode = path => { const bytes = readFileSync(path); return options.encoding && options.encoding !== 'buffer' ? bytes.toString(options.encoding) : bytes; };
  const output = decode(stdout), errors = decode(stderr);
  if (failure) {
    Object.assign(failure, { stdout: output, stderr: errors, output: [null, output, errors] });
    failure.message += '\\n' + String(errors);
    throw failure;
  }
  return output;
};
syncBuiltinESMExports();
`, { mode: 0o600 });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const receipt = {
  schema: 1, pollingProofSha256: "b".repeat(64), mappingProofCount: 22, eventProofCount: 44, account: "917680434255", app: "d1nuh9rw1hcuxo", branch: "codex-hoa-account-migration", backendBranch: "main",
  sourceQuiescedAt: new Date(Date.now()-600000).toISOString(), finalSyncCompletedAt: new Date(Date.now()-540000).toISOString(),
  pendingWorkReconciledAt: new Date(Date.now()-480000).toISOString(), pollingVerifiedAt: new Date(Date.now()-420000).toISOString(),
  reviewedAt: new Date(Date.now()-360000).toISOString(), reviewedBy: "test fixture", finalSyncReceiptSha256: "a".repeat(64), mappingUuids: Array.from({length:22},(_,i)=>`uuid-${i}`),
};
const baseline = {
  ...process.env, PATH: `${dir}:${process.env.PATH}`, AWS_APP_ID: "d1nuh9rw1hcuxo", AWS_BRANCH: "codex-hoa-account-migration",
  HOA_MIGRATION_RELEASE_RECEIPT: JSON.stringify(receipt),
  HOA_MIGRATION_PENDING_CUTOFF: receipt.finalSyncCompletedAt,
  HOA_DEPLOY_ACCOUNT_ID: "917680434255", HOA_MIGRATION_AUTH: "true", HOA_MIGRATION_PREVIEW: "true",
  HOA_MIGRATION_STREAM_PHASE: "quarantine", VITE_HOA_MIGRATION_PREVIEW: "true", PUBLIC_GOOGLE_PLACES_KEY: "", VITE_GOOGLE_PLACES_KEY: "",
};
function captureNode(args: string[], env: Record<string, string | undefined>) {
  const stdout = join(dir, "guard.stdout"), stderr = join(dir, "guard.stderr");
  const descriptors: number[] = [];
  try {
    descriptors.push(openSync(stdout, "w", 0o600));
    descriptors.push(openSync(stderr, "w", 0o600));
    execFileSync(process.execPath, ["--import", preload, ...args], { env, stdio: ["ignore", descriptors[0], descriptors[1]] });
    return readFileSync(stdout, "utf8");
  } catch (error) {
    // Keep the native status/signal while exposing the actual guard rejection.
    // Negative cases assert that message, so launch/capture failures cannot pass.
    if (error instanceof Error) error.message += "\n" + readFileSync(stderr, "utf8");
    throw error;
  } finally { descriptors.forEach(closeSync); }
}
function run(env: Record<string, string | undefined> = {}, args: string[] = []) {
  return captureNode([resolve("scripts/assert-migration-destination.mjs"), ...args], { ...baseline, ...(env.HOA_MIGRATION_PREVIEW === "false" ? { HOA_MIGRATION_WORKERS_ENABLED: "true" } : {}), ...env });
}
describe("destination deployment and replay barrier", () => {
  it("preserves the fake AWS JSON and native failure status through file capture", () => {
    const probe = `
      import { execFileSync } from 'node:child_process';
      const branch = JSON.parse(execFileSync('aws', ['amplify', 'get-branch', '--branch-name', 'main'], { encoding: 'utf8' })).branch;
      try { execFileSync('aws', ['unsupported'], { encoding: 'utf8' }); throw new Error('Expected the fake command to fail'); }
      catch (error) {
        if (error.status !== 4 || error.signal !== null) throw error;
        console.log(JSON.stringify({ branch: branch.branchName, status: error.status, stderr: error.stderr }));
      }
    `;
    expect(JSON.parse(captureNode(["--input-type=module", "-e", probe], baseline))).toEqual({ branch: "main", status: 4, stderr: "Unsupported fake AWS operation\n" });
  });
  it("accepts the isolated quarantine build", () => expect(run()).toContain("read-only preview"));
  it.each([
    [{ HOA_TEST_FAILURE: "account" }, "Refusing HOA deployment outside the dedicated destination account."],
    [{ HOA_TEST_FAILURE: "namespace" }, "The stable backend namespace needs its matching destination branch."],
    [{ HOA_TEST_FAILURE: "autobuild" }, "Backend namespace branches must stay dormant"],
    [{ AWS_APP_ID: "d2d4g940z91vj4" }, "HOA migration deployment is not bound to an approved app and mode."],
    [{ AWS_BRANCH: "main" }, "HOA steady-state deployment: explicit production mode required"],
    [{ VITE_GOOGLE_PLACES_KEY: "provider-key" }, "Provider credentials must be absent from the migration preview."],
    [{ VITE_HOA_MIGRATION_PREVIEW: "false" }, "Preview frontend isolation must be explicitly enabled."],
  ] as const)("rejects a wrong destination or missing frontend fence: %j", (env, message) => expect(() => run(env)).toThrow(message));
  it("uses the staging namespace for its separate hosted preview", () => expect(run({ AWS_BRANCH: "codex-hoa-staging-migration" })).toContain("staging"));
  it("rejects the staging-only backend spec on main, another app, preview or a missing steady-state mode", () => {
    for (const delta of [{ AWS_BRANCH: "main" }, { AWS_APP_ID: "d2d4g940z91vj4" },
      { AWS_BRANCH: "codex-hoa-staging-migration", HOA_DEPLOYMENT_MODE: "steady-state" },
      { AWS_BRANCH: "codex-hoa-staging-migration", HOA_MIGRATION_PREVIEW: "false" }]) {
      expect(() => run(delta, ["--staging-only"])).toThrow("The staging backend build spec can deploy only the retained business staging backend.");
    }
    expect(() => run({}, ["--skip-guard"])).toThrow("Unexpected deployment guard argument.");
  });
  it("rejects release directly from quarantine", () => expect(() => run({ HOA_MIGRATION_PREVIEW: "false" })).toThrow("Release requires separately armed streams."));
  it.each([
    ["old", "A quarantined import stream has not been replaced."],
    ["disabled", "Fresh stream cursors are not yet fully armed."],
    ["replay", "Fresh stream cursors are not yet fully armed."],
    ["polling", "Keep the write fence until every fresh stream cursor is polling successfully."],
    ["recent", "Keep the write fence until every fresh stream cursor is polling successfully."],
  ])("rejects a release while stream state is %s", (failure, message) => {
    expect(() => run({ HOA_MIGRATION_PREVIEW: "false", HOA_MIGRATION_STREAM_PHASE: "armed", HOA_TEST_FAILURE: failure })).toThrow(message);
  });
  it("rejects release without a reviewed final-copy receipt", () => expect(() => run({ HOA_MIGRATION_PREVIEW: "false", HOA_MIGRATION_STREAM_PHASE: "armed", HOA_MIGRATION_RELEASE_RECEIPT: "" })).toThrow("Release needs a reviewed final-copy and pending-work receipt."));
  it("rejects cursor UUIDs different from the reviewed receipt", () => expect(() => run({ HOA_MIGRATION_PREVIEW: "false", HOA_MIGRATION_STREAM_PHASE: "armed", HOA_MIGRATION_RELEASE_RECEIPT: JSON.stringify({ ...receipt, mappingUuids: receipt.mappingUuids.map(x => `${x}-old`) }) })).toThrow("Live stream cursors differ from the reviewed release receipt."));
  it("requires all 22 already-existing fresh cursors before release", () => {
    expect(run({ HOA_MIGRATION_PREVIEW: "false", HOA_MIGRATION_STREAM_PHASE: "armed" })).toContain("release");
  });
  it.each(["", receipt.sourceQuiescedAt, receipt.pendingWorkReconciledAt])("rejects a cutoff not equal to final-copy completion: %s", cutoff => {
    expect(() => run({ HOA_MIGRATION_PREVIEW: "false", HOA_MIGRATION_STREAM_PHASE: "armed", HOA_MIGRATION_PENDING_CUTOFF: cutoff })).toThrow("Inherited-work cutoff differs from the reviewed final copy.");
  });
  it("permits held API priming only with reviewed source and destination fences", () => {
    const prepare = { ...receipt, phase: "writers-held", sourceFenceReceiptSha256: "c".repeat(64), destinationFenceReceiptSha256: "d".repeat(64), pendingWorkReceiptSha256: "e".repeat(64) };
    const held = { HOA_MIGRATION_PREVIEW: "false", HOA_MIGRATION_WORKERS_ENABLED: "false", HOA_MIGRATION_STREAM_PHASE: "armed", HOA_MIGRATION_SCHEDULES_ENABLED: "false", HOA_TRANSACTIONAL_MAIL_RELEASE: "false", HOA_MIGRATION_PREPARE_RECEIPT: JSON.stringify(prepare), HOA_MIGRATION_RELEASE_RECEIPT: "" };
    expect(run(held)).toContain("release");
    for (const [patch, message] of [
      [{ HOA_MIGRATION_PREPARE_RECEIPT: "" }, "API priming requires reviewed source/destination fences and a final-copy receipt."],
      [{ HOA_MIGRATION_SCHEDULES_ENABLED: "true" }, "Primed APIs must retain worker, schedule and mail fences."],
      [{ HOA_TRANSACTIONAL_MAIL_RELEASE: "true" }, "Primed APIs must retain worker, schedule and mail fences."],
      [{ HOA_MIGRATION_PREPARE_RECEIPT: JSON.stringify({ ...prepare, destinationFenceReceiptSha256: "" }) }, "The API priming receipt does not prove a fresh reviewed copy with both write fences."],
    ] as const) expect(() => run({ ...held, ...patch })).toThrow(message);
  });
  it("requires a real marker proof hash and all mapping insert/remove proofs", () => {
    for (const patch of [{ pollingProofSha256: "" }, { eventProofCount: 22 }]) expect(() => run({ HOA_MIGRATION_PREVIEW: "false", HOA_MIGRATION_STREAM_PHASE: "armed", HOA_MIGRATION_RELEASE_RECEIPT: JSON.stringify({ ...receipt, ...patch }) })).toThrow("Release receipt does not prove reviewed final sync, pending work and polling readiness for this backend.");
  });

});
