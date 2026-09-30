import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { TeamEligibility } from "../../../../shared/leadWorkflow";
import { batchGet, conflict, db, get, query, row, save, table, websiteProducerGroup } from "./store";

export const PRODUCER_INDEX_MIGRATION_ID = "migration:website-producers:v1";
const PAGE_SIZE = 8;

/** One bounded rotation leg. The normal leg starts after the last owner; the
 * wrapped leg ends at that owner. Keep the same bound when resuming a page. */
export async function indexedProducerPage(input: { after?: string; through?: string; nextToken?: string } = {}) {
  if (input.after !== undefined && input.through !== undefined) throw new Error("Choose one producer rotation bound");
  let cursor: Record<string, unknown> | undefined;
  if (input.nextToken) {
    try { cursor = JSON.parse(Buffer.from(input.nextToken, "base64url").toString()); }
    catch { throw new Error("Invalid producer page token"); }
  }
  const bound = input.after !== undefined ? "after" : input.through !== undefined ? "through" : undefined;
  const page = await db.send(new QueryCommand({
    TableName: table(), IndexName: "website-producers", Limit: PAGE_SIZE, ScanIndexForward: true,
    KeyConditionExpression: `#group = :group${bound ? ` AND #id ${bound === "after" ? ">" : "<="} :${bound}` : ""}`,
    ExpressionAttributeNames: { "#group": "producerGroup", ...(bound ? { "#id": "id" } : {}) },
    ExpressionAttributeValues: { ":group": "WEBSITE", ...(bound ? { [`:${bound}`]: `eligibility:${input[bound]}` } : {}) },
    ExclusiveStartKey: cursor,
  }));
  const ids = (page.Items ?? []).map(item => String(item.id));
  const current = await batchGet<TeamEligibility>(ids);
  // Index projection is only discovery. Decisions and transaction guards use
  // current primary rows, so a removed or disabled producer cannot be selected.
  const items = ids.flatMap(id => {
    const member = current.get(id);
    return member?.kind === "ELIGIBILITY" && websiteProducerGroup(member.id, member.data) ? [member] : [];
  });
  return {
    items,
    nextToken: page.LastEvaluatedKey ? Buffer.from(JSON.stringify(page.LastEvaluatedKey)).toString("base64url") : undefined,
    lastUserId: ids.at(-1)?.slice("eligibility:".length),
  };
}

/** Upgrade pre-index eligibility in bounded pages. New eligibility writes
 * maintain membership automatically; current primary reads and conditional
 * rewrites prevent an old index projection from restoring revoked access. */
export async function migrateProducerIndex(options: { maxPages?: number; budgetMs?: number } = {}) {
  const deadline = Date.now() + (options.budgetMs ?? 10_000);
  let checkpoint = await get<{ cursor?: string; complete?: boolean; processed?: number }>(PRODUCER_INDEX_MIGRATION_ID);
  if (checkpoint?.data.complete) return;
  for (let pageNumber = 0; pageNumber < (options.maxPages ?? 10) && Date.now() < deadline; pageNumber++) {
    const page = await query<TeamEligibility>("kind", "ELIGIBILITY", checkpoint?.data.cursor, 100);
    const currentRows = await batchGet<TeamEligibility>(page.items.map(candidate => candidate.id));
    for (let offset = 0; offset < page.items.length; offset += 25) {
      if (Date.now() >= deadline) return;
      const results = await Promise.allSettled(page.items.slice(offset, offset + 25).map(async candidate => {
        let current = currentRows.get(candidate.id);
        for (let attempt = 0; attempt < 3; attempt++) {
          if (!current || current.kind !== "ELIGIBILITY") return;
          const group = websiteProducerGroup(current.id, current.data);
          if (current.producerGroup === group) return;
          if (Date.now() >= deadline) throw new Error("Producer index migration will resume this page");
          try {
            await save(row("ELIGIBILITY", current.id, current.data, { previous: current, accountId: current.accountId, dueAt: current.dueAt }), current);
            return;
          } catch (error) {
            if (!conflict(error) || attempt === 2) throw error;
            current = await get<TeamEligibility>(candidate.id);
          }
        }
      }));
      // Complete in-flight changes before surfacing failure. The checkpoint
      // advances only after all rows succeed; rerunning a page is idempotent.
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
    if (Date.now() >= deadline) return;
    checkpoint = await save(row("MIGRATION", PRODUCER_INDEX_MIGRATION_ID, {
      cursor: page.nextToken, complete: !page.nextToken, processed: (checkpoint?.data.processed ?? 0) + page.items.length,
    }, { previous: checkpoint }), checkpoint);
    if (!page.nextToken) return;
  }
}
