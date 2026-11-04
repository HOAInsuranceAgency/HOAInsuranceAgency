// Run from crm: node --import tsx scripts/benchmarks/account-detail-reads.mjs
// No AWS calls. The baseline administrator path models the former generated
// Scan resolver (100 small rows per page); the indexed path runs real listing
// code with a DynamoDB service stub. Counts are structural, not AWS timings.
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const records = new Map();
let stats, filter;
DynamoDBDocumentClient.from = () => ({ send: async command => {
  const input = command.input;
  if (input.RequestItems) {
    stats.batchGetCommands++;
    return { Responses: Object.fromEntries(Object.entries(input.RequestItems).map(([table, request]) => {
      stats.consistentRecordKeyReads += request.Keys.length;
      return [table, request.Keys.map(key => records.get(`${table}:${key.id ?? key.accountId}`)).filter(Boolean)];
    })) };
  }
  if (input.Key) {
    stats.getCommands++; stats.consistentRecordKeyReads++;
    return { Item: records.get(`${input.TableName}:${input.Key.id ?? input.Key.accountId}`) };
  }
  stats.queryCommands++;
  const partition = input.ExpressionAttributeNames["#scope"], scope = input.ExpressionAttributeValues[":scope"];
  const candidates = [...records.entries()].filter(([key, row]) => key.startsWith(`${input.TableName}:`) && row[partition] === scope)
    .map(([, row]) => row).sort((a, b) => a.id.localeCompare(b.id));
  const start = input.ExclusiveStartKey ? candidates.findIndex(row => row.id === input.ExclusiveStartKey.id) + 1 : 0;
  const evaluated = candidates.slice(start, start + input.Limit);
  stats.candidateRowsEvaluated += evaluated.length;
  return { Items: evaluated.filter(row => matchesFilter(row, filter)), ScannedCount: evaluated.length,
    ...(start + evaluated.length < candidates.length ? { LastEvaluatedKey: { id: evaluated.at(-1).id, [partition]: scope } } : {}) };
} });
process.env.COMMUNICATION_TABLE = "Communication";
process.env.ACCESS_TABLES = JSON.stringify(Object.fromEntries(["Contact", "Policy", "Document"].map(name => [name, name])));
process.env.ACCESS_INDEXES = JSON.stringify({ "Contact.accountId": "by_accountId", "Policy.accountId": "by_accountId", "Document.entityId": "by_entityId" });
const { AccountAccess } = await import("../../amplify/functions/crm-access/access.ts");
const { listAssigned, matchesFilter } = await import("../../amplify/functions/crm-access/listing.ts");
const emptyStats = () => ({ apiPages: 0, scanCommands: 0, queryCommands: 0, batchGetCommands: 0, getCommands: 0, candidateRowsEvaluated: 0, consistentRecordKeyReads: 0 });
async function indexed(role, model) {
  stats = emptyStats(); const items = []; let nextToken;
  do {
    const access = new AccountAccess({ sub: "alice", groups: [role] }, undefined, { headers: { "x-crm-role": role } });
    const page = await listAssigned(access, model, { filter, nextToken });
    stats.apiPages++; items.push(...page.items); nextToken = page.nextToken;
  } while (nextToken);
  return { ...stats, returnedRows: items.length, ids: items.map(row => row.id).sort() };
}
function nativeScan(model) {
  const before = emptyStats(), rows = [...records.entries()].filter(([key]) => key.startsWith(`${model}:`)).map(([, row]) => row), items = [];
  for (let offset = 0; offset < rows.length; offset += 100) {
    const page = rows.slice(offset, offset + 100);
    before.apiPages++; before.scanCommands++; before.candidateRowsEvaluated += page.length;
    items.push(...page.filter(row => matchesFilter(row, filter)));
  }
  return { ...before, returnedRows: items.length, ids: items.map(row => row.id).sort() };
}
const results = [];
for (const model of ["Contact", "Policy", "Document"]) {
  records.clear();
  const scope = (id) => model === "Document" ? { entityId: id, entityType: "ACCOUNT" } : { accountId: id };
  for (let i = 0; i < 200; i++) records.set(`${model}:other-${i}`, { id: `other-${i}`, ...scope(`other-account-${i}`) });
  for (let i = 0; i < 30; i++) records.set(`${model}:target-${i}`, { id: `target-${i}`, ...scope("target") });
  records.set("Communication:workflow:target", { id: "workflow:target", data: { salespersonId: "alice" } });
  records.set("Account:target", { id: "target" });
  process.env.ACCESS_TABLES = JSON.stringify({ ...JSON.parse(process.env.ACCESS_TABLES), Account: "Account" });
  filter = Object.fromEntries(Object.entries(scope("target")).map(([key, value]) => [key, { eq: value }]));
  for (const role of ["ADMIN", "OWNER", "PRODUCER", "STAFF"]) {
    const before = ["ADMIN", "OWNER"].includes(role) ? nativeScan(model) : await indexed(role, model);
    const after = await indexed(role, model);
    if (JSON.stringify(before.ids) !== JSON.stringify(after.ids)) throw new Error(`Result mismatch: ${role}/${model}`);
    delete before.ids; delete after.ids;
    results.push({ role, model, baselineMethod: ["ADMIN", "OWNER"].includes(role) ? "modeled former native Scan resolver" : "unchanged real indexed listing code", before, after });
  }
}
const report = { kind: "structural simulation; no AWS network or wall-clock latency measurements", fixture: { targetRowsPerTable: 30, unrelatedRowsPerTable: 200, nativeScanRowsPerPage: 100 },
  caveats: ["Baseline native Scan behavior is modeled, not a deployment of the previous resolver.", "Indexed reads execute the actual revised listAssigned/AccountAccess code with service stubs.", "Session guards run before either path in production and are excluded here; those controls are unchanged.", "Candidate evaluations and consistent key reads are shown separately, not as billed DynamoDB capacity."], results };
const destination = new URL("../performance-audit-results/detail-backend.json", import.meta.url);
mkdirSync(fileURLToPath(new URL("../performance-audit-results/", import.meta.url)), { recursive: true });
writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
