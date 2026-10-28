import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { TeamEligibility } from "../../../../shared/leadWorkflow";
import { batchGet, conflict, db, get, query, row, save, table, websiteProducerGroup } from "./store";
import { producerDirectoryPage, syncProducerEligibility } from "./workflow";

export const PRODUCER_INDEX_MIGRATION_ID = "migration:website-producers:v2";
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

interface DirectoryCheckpoint {
  phase?: "ELIGIBILITY" | "PRODUCERS";
  cursor?: string;
  producerToken?: string;
  complete?: boolean;
  refreshAfter?: string;
  processed?: number;
}

/** Reconcile saved preferences and discover new Producer memberships independently
 * of UI visits. Keep the completed bootstrap usable during subsequent cycles. */
export async function migrateProducerIndex(options: { maxPages?: number; budgetMs?: number } = {}) {
  const deadline = Date.now() + (options.budgetMs ?? 10_000);
  let checkpoint = await get<DirectoryCheckpoint>(PRODUCER_INDEX_MIGRATION_ID);
  if (checkpoint?.data.complete && !checkpoint.data.phase && Date.parse(checkpoint.data.refreshAfter ?? "") > Date.now()) return;
  let state: DirectoryCheckpoint = { ...checkpoint?.data, phase: checkpoint?.data.phase ?? "ELIGIBILITY" };
  for (let pageNumber = 0; pageNumber < (options.maxPages ?? 10) && Date.now() < deadline; pageNumber++) {
    if (state.phase === "ELIGIBILITY") {
      const page = await query<TeamEligibility>("kind", "ELIGIBILITY", state.cursor, 4);
      const currentRows = await batchGet<TeamEligibility>(page.items.map(candidate => candidate.id));
      for (let offset = 0; offset < page.items.length; offset += 4) {
        const results = await Promise.allSettled(page.items.slice(offset, offset + 4).map(async candidate => {
          let current = currentRows.get(candidate.id);
          if (!current || current.kind !== "ELIGIBILITY") return;
          const userId = current.data.userId;
          if (typeof userId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(userId) && current.id === `eligibility:${userId}`) {
            await syncProducerEligibility(userId, current);
            return;
          }
          // Invalid historical identities cannot block valid Producers or remain
          // discoverable through an old index projection.
          for (let attempt = 0; current?.producerGroup && attempt < 3; attempt++) {
            try {
              await save(row("ELIGIBILITY", current.id, current.data, { previous: current, accountId: current.accountId, dueAt: current.dueAt }), current);
              return;
            } catch (error) {
              if (!conflict(error) || attempt === 2) throw error;
              current = await get<TeamEligibility>(candidate.id);
            }
          }
        }));
        const failure = results.find(result => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      }
      state = { ...state, cursor: page.nextToken, phase: page.nextToken ? "ELIGIBILITY" : "PRODUCERS", processed: (state.processed ?? 0) + page.items.length };
    } else {
      const page = await producerDirectoryPage(state.producerToken);
      const ids = (page.Users ?? []).flatMap(user => {
        const userId = user.Attributes?.find(attribute => attribute.Name === "sub")?.Value;
        return typeof userId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(userId) ? [userId] : [];
      });
      for (let offset = 0; offset < ids.length; offset += 4) {
        const results = await Promise.allSettled(ids.slice(offset, offset + 4).map(id => syncProducerEligibility(id)));
        const failure = results.find(result => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      }
      state = page.NextToken ? { ...state, producerToken: page.NextToken }
        : { complete: true, processed: state.processed, refreshAfter: new Date(Date.now() + 60_000).toISOString() };
    }
    checkpoint = await save(row("MIGRATION", PRODUCER_INDEX_MIGRATION_ID, state, { previous: checkpoint }), checkpoint);
    if (!state.phase) return;
  }
}
