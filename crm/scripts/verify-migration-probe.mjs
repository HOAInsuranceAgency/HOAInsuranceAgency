import { createHash } from "node:crypto";

/** Read-only preflight: no probe record can target a foreign/stale stream. */
export function verifyMigrationProbe(raw, receipt, root, targets, backendBranch, aws) {
  if (!raw || Buffer.byteLength(raw) > 5000 || createHash("sha256").update(raw).digest("hex") !== receipt.probeScopeManifestSha256) throw new Error("Probe scope differs from the reviewed prepare receipt.");
  const scope = JSON.parse(raw);
  if (!scope || Array.isArray(scope) || JSON.stringify(Object.keys(scope).sort()) !== JSON.stringify(["activityLog", "communicationWorker", "honeycombWorker", "honeycombSubmissionWorker"].sort())) throw new Error("Probe scope worker inventory differs.");
  if (!root?.startsWith(`arn:aws:cloudformation:${targets.region}:${targets.account}:stack/amplify-${targets.crmApp}-${backendBranch}-branch-`)) throw new Error("No matching existing backend owns the probe.");
  const pending = [root], visited = new Set(), tables = new Set();
  while (pending.length) {
    const arn = pending.pop();
    if (visited.has(arn) || visited.size >= 100 || !arn.startsWith(`arn:aws:cloudformation:${targets.region}:${targets.account}:stack/amplify-${targets.crmApp}-`)) throw new Error("Unrecognized probe backend graph.");
    visited.add(arn);
    for (const r of aws("cloudformation", "list-stack-resources", "--stack-name", arn).StackResourceSummaries) {
      if (r.ResourceStatus === "DELETE_COMPLETE") continue;
      if (r.ResourceType === "AWS::CloudFormation::Stack") pending.push(r.PhysicalResourceId);
      if (["AWS::DynamoDB::Table", "Custom::AmplifyDynamoDBTable"].includes(r.ResourceType)) tables.add(r.PhysicalResourceId);
    }
  }
  if (tables.size !== 44) throw new Error("The probe backend table inventory changed.");
  const rows = Object.values(scope).flat();
  if (rows.length !== 22) throw new Error("Expected scopes for exactly22 stream mappings.");
  const verified = new Map();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 3 || !tables.has(row[0])) throw new Error("Probe scope targets an unowned table/key.");
    const [name, label, key] = row;
    const model = /^([A-Za-z]+)-[a-z0-9]{26}-NONE$/.exec(name)?.[1];
    const expectedKey = ["GlApplication", "DoApplication"].includes(model) ? "accountId" : "id";
    if (!model || key !== expectedKey) throw new Error("Probe scope does not use its model key.");
    if (!verified.has(name)) verified.set(name, aws("dynamodb", "describe-table", "--table-name", name).Table);
    const live = verified.get(name), tableArn = `arn:aws:dynamodb:${targets.region}:${targets.account}:table/${name}`;
    if (live.TableArn !== tableArn || live.TableStatus !== "ACTIVE" || live.LatestStreamArn !== `${tableArn}/stream/${label}` || JSON.stringify(live.KeySchema) !== JSON.stringify([{ AttributeName: key, KeyType: "HASH" }])) throw new Error("Probe scope does not match the current owned table/stream generation.");
  }
  if (verified.size !== 17) throw new Error("Probe scopes must cover all17 distinct streamed models.");
}
