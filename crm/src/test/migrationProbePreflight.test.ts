import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { PROBE_MODELS } from "../../amplify/migration-probe-scopes";
// @ts-expect-error The deployment preflight is intentionally executable plain JS.
import { verifyMigrationProbe } from "../../scripts/verify-migration-probe.mjs";
const targets = { region: "us-east-1", account: "917680434255", crmApp: "d1nuh9rw1hcuxo" };
const root = "arn:aws:cloudformation:us-east-1:917680434255:stack/amplify-d1nuh9rw1hcuxo-main-branch-test/id";
const label = "2026-10-29T20:00:00.000";
const scope = Object.fromEntries(Object.entries(PROBE_MODELS).map(([w, ms]) => [w, ms.map(m => [`${m}-${"a".repeat(26)}-NONE`, label, "id"])]));
const raw = JSON.stringify(scope), receipt = { probeScopeManifestSha256: createHash("sha256").update(raw).digest("hex") };
function readOnlyAws(failure = "") {
  const names = [...new Set(Object.values(scope).flat().map(row => row[0]))];
  return vi.fn((service: string, _action: string, _option: string, name: string) => {
    if (service === "cloudformation") return { StackResourceSummaries: [...names, ...Array.from({ length: 27 }, (_, i) => `unstreamed-${i}`)].map(n => ({ ResourceType: "AWS::DynamoDB::Table", PhysicalResourceId: n, ResourceStatus: "CREATE_COMPLETE" })) };
    if (service !== "dynamodb") throw new Error("Unexpected service or mutation");
    const arn = `arn:aws:dynamodb:us-east-1:${failure === "account" ? "637423611040" : targets.account}:table/${name}`;
    return { Table: { TableArn: arn, TableStatus: "ACTIVE", LatestStreamArn: `${arn}/stream/${failure === "stream" ? "2026-01-01T00:00:00.000" : label}`, KeySchema: [{ AttributeName: failure === "key" ? "other" : "id", KeyType: "HASH" }] } };
  });
}
describe("live metadata probe preflight", () => {
  it("checks17ownedtablegenerations using read-only metadata calls", () => { const aws = readOnlyAws(); verifyMigrationProbe(raw, receipt, root, targets, "main", aws); expect(aws.mock.calls.filter(c => c[0] === "dynamodb")).toHaveLength(17); });
  it.each(["account", "stream", "key"])("rejects changed%s metadata", failure => expect(() => verifyMigrationProbe(raw, receipt, root, targets, "main", readOnlyAws(failure))).toThrow());
  it("rejects stale scope review and wrong namespace before AWS calls", () => { const aws = readOnlyAws(); expect(() => verifyMigrationProbe(raw, {}, root, targets, "main", aws)).toThrow(); expect(() => verifyMigrationProbe(raw, receipt, root, targets, "staging", aws)).toThrow(); expect(aws).not.toHaveBeenCalled(); });
});
