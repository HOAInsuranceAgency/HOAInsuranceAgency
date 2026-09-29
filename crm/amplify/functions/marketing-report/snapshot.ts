import { ScanCommand, type ScanCommandInput } from "@aws-sdk/lib-dynamodb";
import type { ReportRecord, ReportSnapshot } from "../../../../shared/marketingLeadReport";
import { db, table } from "../communications/store";

// Exhaust every page or fail the whole run. A bounded failure is preferable to
// attaching a plausible workbook silently missing the rest of a large table.
interface Budget { deadline: number; rows: number; bytes: number; pages: number }
export async function scanComplete(input: Omit<ScanCommandInput, "ExclusiveStartKey">, budget: Budget): Promise<ReportRecord[]> {
  const rows: ReportRecord[] = [];
  let cursor: Record<string, unknown> | undefined;
  const cursors = new Set<string>();
  do {
    if (Date.now() > budget.deadline || ++budget.pages > 2_000) throw new Error("The report exceeded its collection limit. No incomplete report was sent.");
    const result = await db.send(new ScanCommand({ ...input, ConsistentRead: true, Limit: 250, ExclusiveStartKey: cursor }));
    const items = (result.Items ?? []) as ReportRecord[];
    budget.rows += items.length;
    budget.bytes += Buffer.byteLength(JSON.stringify(items));
    if (budget.rows > 100_000 || budget.bytes > 48 * 1024 * 1024) throw new Error("The report exceeded its size limit. No incomplete report was sent.");
    rows.push(...items);
    cursor = result.LastEvaluatedKey;
    if (cursor) {
      const key = JSON.stringify(cursor);
      if (cursors.has(key)) throw new Error("Report pagination did not advance. No incomplete report was sent.");
      cursors.add(key);
    }
  } while (cursor);
  return rows;
}
const sources = { accounts: "ACCOUNT_TABLE", quotes: "QUOTE_TABLE", policies: "POLICY_TABLE", priorCarriers: "PRIOR_CARRIER_TABLE", carriers: "CARRIER_TABLE", documents: "DOCUMENT_TABLE", activities: "ACTIVITY_TABLE" } as const;
const modelFields: Record<keyof typeof sources, string[]> = {
  accounts: ["name", "state", "type", "propertyType", "unitCount", "stage", "leadSource", "source", "leadAttribution", "priorCarrierName", "priorPremium", "priorTermEffective", "priorTermExpiration", "currentPolicyExpiration", "convertedAt", "notes"],
  quotes: ["accountId", "renewalPolicyId", "presentedAt", "status", "carrierId", "premium", "lines"],
  policies: ["accountId", "datePolicyBound", "quoteId", "status", "carrierId", "carrierName", "premium", "lines", "lineOfBusiness", "effectiveDate", "expirationDate"],
  priorCarriers: ["accountId", "carrierName", "premium", "lines", "lineOfBusiness", "effectiveDate", "expirationDate", "status"],
  carriers: ["name"],
  documents: ["entityId", "entityType", "s3Key", "quoteId", "policyId", "category", "sourceCommunicationId", "lastWriteBy", "name", "ocrStatus"],
  activities: ["entityId", "subjectId", "occurredAt", "changes"],
};
function projection(fields: string[]) {
  const names: Record<string, string> = {};
  const expressions = fields.map(path => path.split(".").map(part => { const key = `#p${Object.keys(names).length}`; names[key] = part; return key; }).join("."));
  return { ProjectionExpression: expressions.join(", "), ExpressionAttributeNames: names };
}
/** Current links override stale communication projections after reassignment. */
export function linkedCommunications(records: ReportRecord[]): ReportRecord[] {
  const links = new Map(records.filter(record => record.kind === "LINK").map(record => [record.id, record.data as ReportRecord]));
  return records.filter(record => record.kind === "COMMUNICATION").flatMap(record => {
    const data = record.data as ReportRecord;
    const accountId = record.accountId;
    if (!accountId || data.accountId !== accountId) return [];
    const exact = links.get(`activity-link:${record.id}`);
    const conversation = data.conversationId ? links.get(`front-link:${data.conversationId}`) : undefined;
    if ([exact, conversation].some(link => link && link.accountId !== accountId)) return [];
    if ([exact, conversation].some(link => link?.purpose === "CARRIER" || ["SERVICE", "RENEWAL"].includes(String(link?.context)))) return [];
    const purpose = exact?.purpose ?? conversation?.purpose;
    // Email must retain a current prospect link, not merely an old stored purpose.
    if (data.channel === "EMAIL" && purpose !== "PROSPECT") return [];
    return [{ ...data, id: record.id, purpose: purpose ?? data.purpose, context: exact?.context ?? conversation?.context ?? data.context }];
  });
}
export async function reportSnapshot(): Promise<ReportSnapshot> {
  const budget: Budget = { deadline: Date.now() + 180_000, rows: 0, bytes: 0, pages: 0 };
  const result = {} as ReportSnapshot;
  // Sequential requests preserve a predictable read budget in production.
  for (const [key, env] of Object.entries(sources)) {
    const TableName = process.env[env];
    if (!TableName) throw new Error("The report data sources are not configured.");
    result[key as keyof typeof sources] = await scanComplete({ TableName, ...projection(["id", "createdAt", ...modelFields[key as keyof typeof sources]]) }, budget);
  }
  const fields = ["id", "accountId", "conversationId", "createdAt", "channel", "direction", "at", "endedAt", "status", "classification", "purpose", "domain", "context", "frontDraft", "internalReport", "outcome", "actorId", "text", "attachments", "summary", "subject", "seenAt", "disposition", "deferredUntil"];
  // Read only classification evidence from intake; full snapshots contain
  // contact details and token-bearing values that do not belong in reports.
  const selected = projection(["id", "kind", "accountId", ...fields.map(field => `data.${field}`), "data.receivedAt", "data.snapshot.propertyKind", "data.snapshot.answers.Property type"]);
  const records = await scanComplete({ TableName: table(), ...selected, FilterExpression: "#kind IN (:workflow, :communication, :link, :submission)", ExpressionAttributeNames: { ...selected.ExpressionAttributeNames, "#kind": "kind" }, ExpressionAttributeValues: { ":workflow": "WORKFLOW", ":communication": "COMMUNICATION", ":link": "LINK", ":submission": "SUBMISSION" } }, budget);
  const select = (kind: string) => records.filter(record => record.kind === kind).map(record => record.data as ReportRecord);
  result.workflows = select("WORKFLOW");
  result.communications = linkedCommunications(records);
  result.submissions = select("SUBMISSION").map(data => {
    const snapshot = data.snapshot as { propertyKind?: unknown; answers?: Record<string, unknown> } | undefined;
    return { accountId: data.accountId, createdAt: data.receivedAt, propertyKind: snapshot?.propertyKind, answerPropertyKind: snapshot?.answers?.["Property type"] };
  });
  return result;
}
