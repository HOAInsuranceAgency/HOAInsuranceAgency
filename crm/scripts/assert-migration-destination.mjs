import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const targets = JSON.parse(readFileSync(new URL("../amplify/migration-targets.json", import.meta.url), "utf8"));
const branch = process.env.AWS_BRANCH ?? "";
const binding = targets.branches[branch];
if (binding) {
  const app = process.env.AWS_APP_ID;
  if (!/^[a-z0-9]+$/.test(targets.crmApp) || !/^[a-z0-9]+$/.test(targets.webApp)
    || ![targets.crmApp, targets.webApp].includes(app)
    || process.env.HOA_MIGRATION_AUTH !== "true"
    || !["true", "false"].includes(process.env.HOA_MIGRATION_PREVIEW ?? "")) {
    throw new Error("HOA migration deployment is not bound to an approved app and mode.");
  }
  const account = execFileSync("aws", ["sts", "get-caller-identity", "--query", "Account", "--output", "text"], { encoding: "utf8" }).trim();
  if (account !== targets.account || process.env.HOA_DEPLOY_ACCOUNT_ID !== targets.account) {
    throw new Error("Refusing HOA deployment outside the dedicated destination account.");
  }
  const aws = (...args) => JSON.parse(execFileSync("aws", [...args, "--region", targets.region, "--output", "json"], { encoding: "utf8" }));
  let namespaceBranch;
  if (app === targets.crmApp) {
    namespaceBranch = aws("amplify", "get-branch", "--app-id", app, "--branch-name", binding.backendBranch).branch;
    if (namespaceBranch?.branchName !== binding.backendBranch) throw new Error("The stable backend namespace needs its matching destination branch.");
    if (process.env.HOA_MIGRATION_PREVIEW === "true" && (namespaceBranch.enableAutoBuild !== false || namespaceBranch.enablePullRequestPreview === true)) {
      throw new Error("Backend namespace branches must stay dormant while migration previews are built separately.");
    }
  }
  if (app === targets.webApp && (!binding.graphqlUrl || process.env.PUBLIC_CRM_API_URL !== binding.graphqlUrl)) {
    throw new Error("The website must target its verified destination CRM API.");
  }
  if (process.env.HOA_MIGRATION_PREVIEW === "true") {
    const prefix = app === targets.crmApp ? "VITE" : "PUBLIC";
    if (process.env[`${prefix}_HOA_MIGRATION_PREVIEW`] !== "true") throw new Error("Preview frontend isolation must be explicitly enabled.");
    if (app === targets.webApp && process.env.PUBLIC_ANALYTICS_DISABLED !== "true") throw new Error("Website preview analytics must be disabled.");
    for (const key of ["PUBLIC_GOOGLE_PLACES_KEY", "VITE_GOOGLE_PLACES_KEY"]) {
      if (process.env[key]) throw new Error("Provider credentials must be absent from the migration preview.");
    }
  }
  if (app === targets.crmApp && process.env.HOA_MIGRATION_PREVIEW === "false") {
    if (!["true", "false"].includes(process.env.HOA_MIGRATION_WORKERS_ENABLED ?? "")) throw new Error("Choose an explicit held or active worker phase.");
    if (process.env.HOA_MIGRATION_WORKERS_ENABLED === "false") {
      if (process.env.HOA_MIGRATION_STREAM_PHASE !== "armed" || process.env.HOA_MIGRATION_SCHEDULES_ENABLED === "true" || process.env.HOA_TRANSACTIONAL_MAIL_RELEASE === "true") throw new Error("Primed APIs must retain worker, schedule and mail fences.");
      let receipt;
      try { receipt = JSON.parse(process.env.HOA_MIGRATION_PREPARE_RECEIPT ?? ""); } catch { throw new Error("API priming requires reviewed source/destination fences and a final-copy receipt."); }
      const ordered = [receipt.sourceQuiescedAt, receipt.finalSyncCompletedAt, receipt.pendingWorkReconciledAt, receipt.reviewedAt].map(v => Date.parse(v ?? ""));
      const hashes = [receipt.sourceFenceReceiptSha256, receipt.destinationFenceReceiptSha256, receipt.finalSyncReceiptSha256, receipt.pendingWorkReceiptSha256];
      if (receipt.schema !== 1 || receipt.phase !== "writers-held" || receipt.account !== targets.account || receipt.app !== app || receipt.branch !== branch || receipt.backendBranch !== binding.backendBranch
        || !receipt.reviewedBy || hashes.some(v => !/^[a-f0-9]{64}$/.test(v ?? ""))
        || ordered.some((v, i) => !Number.isFinite(v) || v > Date.now() || (i > 0 && v < ordered[i - 1])) || Date.now() - ordered[3] > 2 * 60 * 60_000) throw new Error("The API priming receipt does not prove a fresh reviewed copy with both write fences.");
    }
  }
  if (app === targets.crmApp && process.env.HOA_MIGRATION_PREVIEW === "false" && process.env.HOA_MIGRATION_WORKERS_ENABLED === "true") {
    if (process.env.HOA_MIGRATION_STREAM_PHASE !== "armed") throw new Error("Release requires separately armed streams.");
    let receipt;
    try { receipt = JSON.parse(process.env.HOA_MIGRATION_RELEASE_RECEIPT ?? ""); } catch { throw new Error("Release needs a reviewed final-copy and pending-work receipt."); }
    const ordered = [receipt.sourceQuiescedAt, receipt.finalSyncCompletedAt, receipt.pendingWorkReconciledAt, receipt.pollingVerifiedAt, receipt.reviewedAt].map(value => Date.parse(value ?? ""));
    if (receipt.schema !== 1 || receipt.account !== targets.account || receipt.app !== app || receipt.branch !== branch || receipt.backendBranch !== binding.backendBranch
      || !/^[a-f0-9]{64}$/.test(receipt.finalSyncReceiptSha256 ?? "") || !/^[a-f0-9]{64}$/.test(receipt.pollingProofSha256 ?? "") || (receipt.mappingProofCount !== 22 || receipt.eventProofCount !== 44) || !receipt.reviewedBy
      || ordered.some((v, i) => !Number.isFinite(v) || v > Date.now() || (i > 0 && v < ordered[i - 1]))
      || Date.now() - ordered[4] > 2 * 60 * 60_000 || !Array.isArray(receipt.mappingUuids) || receipt.mappingUuids.length !== 22) {
      throw new Error("Release receipt does not prove reviewed final sync, pending work and polling readiness for this backend.");
    }
    const hosted = namespaceBranch;
    if (!hosted?.backend?.stackArn?.startsWith(`arn:aws:cloudformation:${targets.region}:${targets.account}:stack/amplify-${app}-${binding.backendBranch}-branch-`)) throw new Error("The stable namespace branch has no matching existing backend to release.");
    const inventory = [];
    const collect = arn => {
      for (const r of aws("cloudformation", "list-stack-resources", "--stack-name", arn).StackResourceSummaries) {
        if (r.ResourceStatus === "DELETE_COMPLETE") continue;
        inventory.push(r);
        if (r.ResourceType === "AWS::CloudFormation::Stack" && r.PhysicalResourceId) collect(r.PhysicalResourceId);
      }
    };
    collect(hosted.backend.stackArn);
    const mappings = inventory.filter(r => r.ResourceType === "AWS::Lambda::EventSourceMapping");
    if (mappings.length !== 22) throw new Error("Stream inventory differs from the reviewed migration contract.");
    if (JSON.stringify(mappings.map(r => r.PhysicalResourceId).sort()) !== JSON.stringify([...receipt.mappingUuids].sort())) throw new Error("Live stream cursors differ from the reviewed release receipt.");
    for (const r of mappings) {
      if (!r.LogicalResourceId.endsWith("MigrationLiveV1")) throw new Error("A quarantined import stream has not been replaced.");
      const live = aws("lambda", "get-event-source-mapping", "--uuid", r.PhysicalResourceId);
      if (live.State !== "Enabled" || live.StartingPosition !== "LATEST") throw new Error("Fresh stream cursors are not yet fully armed.");
      const modified = typeof live.LastModified === "number" ? live.LastModified * 1000 : Date.parse(live.LastModified ?? "");
      if (!["OK", "No records processed"].includes(live.LastProcessingResult) || !Number.isFinite(modified) || Date.now() - modified < 5 * 60_000) {
        throw new Error("Keep the write fence until every fresh stream cursor is polling successfully.");
      }
    }
  }
  console.log(`Verified isolated HOA ${binding.businessEnvironment} deployment (${process.env.HOA_MIGRATION_PREVIEW === "true" ? "read-only preview" : "release"}).`);
} else if (process.env.HOA_MIGRATION_AUTH === "true" || process.env.HOA_MIGRATION_PREVIEW === "true") {
  throw new Error("Migration settings cannot be deployed to an original release branch.");
}
