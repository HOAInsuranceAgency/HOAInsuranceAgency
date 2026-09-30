import { createHash } from "node:crypto";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AccountAccess, db, tableName } from "./access";
import { ACCOUNT_MODELS, RETIRED_MODELS, LIST_PARENTS, AccessDenied, id, listPartition, object, type RecordData } from "./policy";

import { queryFilter, matchesFilter } from "./filters";
export { matchesFilter } from "./filters";

type Key = Record<string, unknown>;
type Cursor = { scope: string; owner: number; assignment?: Key; accounts?: string[]; account?: string; part: number; parent?: string; parentIds?: string[]; parents?: Key; records?: Key; shared: number };
const parentPageSize = 25;
const sharedDocuments = ["CARRIER", "LICENSE", "USER_PROFILE"];
const documentParents = ["Account", "Quote", "Policy", "Certificate"];
const naturalKey = (model: string) => ["GlApplication", "DoApplication"].includes(model);
async function query(model: string, field: string, key: string, limit: number, cursor?: Key, filter: RecordData = {}) {
  const indexes = JSON.parse(process.env.ACCESS_INDEXES ?? "{}") as Record<string, string>;
  const index = model === "Communication" ? "assignment" : indexes[`${model}.${field}`];
  if (!index) throw new Error(`Missing list index for ${model}.${field}`);
  const pushed = queryFilter(filter, field);
  const page = await db.send(new QueryCommand({ TableName: tableName(model), IndexName: index,
    KeyConditionExpression: "#scope = :scope", ...pushed,
    ExpressionAttributeNames: { "#scope": field, ...pushed.ExpressionAttributeNames },
    ExpressionAttributeValues: { ":scope": key, ...pushed.ExpressionAttributeValues },
    Limit: limit, ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
  return { items: page.Items ?? [], cursor: page.LastEvaluatedKey, evaluated: page.ScannedCount ?? page.Items?.length ?? 0 };
}
function decode(token: unknown, scope: string): Cursor {
  if (token == null) return { scope, owner: 0, part: 0, shared: 0 };
  if (typeof token !== "string" || token.length > 16384) throw new AccessDenied();
  try {
    const c = JSON.parse(Buffer.from(token, "base64url").toString()) as Cursor;
    if (c.scope !== scope || ![c.owner, c.part, c.shared].every(n => Number.isSafeInteger(n) && n >= 0)
      || c.accounts && (!Array.isArray(c.accounts) || c.accounts.length > 25 || c.accounts.some(key => !id(key)))
      || c.parentIds !== undefined && (!Array.isArray(c.parentIds) || c.parentIds.length > parentPageSize || c.parentIds.some(key => !id(key)))) throw new Error();
    return c;
  } catch { throw new Error("This list changed. Refresh it to continue."); }
}

/** Fill a page across authorized partitions. Bound sparse searches by time,
 * query count and evaluated records, retaining every unfinished partition in
 * the cursor. Cursors are traversal hints, never proof of current access. */
export async function listAssigned(access: AccountAccess, model: string, args: RecordData) {
  if (RETIRED_MODELS.includes(model) || !(ACCOUNT_MODELS as readonly string[]).includes(model) || access.admin) throw new AccessDenied();
  const filter = object(args.filter), owners = [...await access.salespeople()].sort();
  const scope = createHash("sha256").update(JSON.stringify([access.actor, owners, model, filter])).digest("hex");
  const c = decode(args.nextToken, scope), limit = Math.min(100, Math.max(1, Math.floor(Number(args.limit) || 100)));
  const items: RecordData[] = [], seen = new Set<string>(), deadline = Date.now() + 8_000;
  let queries = 0, evaluated = 0, steps = 0, done = false;
  const withinBudget = () => items.length < limit && queries < 80 && evaluated < 1000 && steps++ < 250 && Date.now() < deadline;
  const readPage = async (name: string, field: string, key: string, count: number, cursor?: Key, predicate?: RecordData) => {
    queries++;
    const page = await query(name, field, key, Math.min(count, Math.max(1, 1000 - evaluated)), cursor, predicate);
    evaluated += page.evaluated;
    return page;
  };
  const append = async (candidates: RecordData[]) => {
    // GSI projections can lag moves/edits. Only filter-matching candidate keys
    // are fetched consistently, then their current ownership and filter checked.
    const keys = candidates.map(item => id(naturalKey(model) ? item.accountId : item.id)).filter(Boolean);
    await access.prefetch(model, keys);
    const currentRecords = (await Promise.all(keys.map(key => access.get(model, key)))).filter((item): item is RecordData => !!item);
    await access.prefetchRecordAccess(model, currentRecords);
    for (const key of keys) {
      const current = await access.get(model, key);
      if (!seen.has(key) && current && matchesFilter(current, filter) && await access.canRecord(model, current)) { items.push(current); seen.add(key); }
    }
  };
  const finish = () => ({ items, nextToken: done ? null : Buffer.from(JSON.stringify(c)).toString("base64url") });
  const field = model === "Account" ? "id" : listPartition(model);
  const exact = id(object(filter[field]).eq);
  if (exact && (model !== "Document" || id(object(filter.entityType).eq))) {
    if (model === "Document") {
      const entityType = id(object(filter.entityType).eq);
      const parent = ({ ACCOUNT: "Account", QUOTE: "Quote", POLICY: "Policy", CERTIFICATE: "Certificate", CARRIER: "Carrier", LICENSE: "License", USER_PROFILE: "UserProfile" } as Record<string, string>)[entityType];
      if (!parent) throw new AccessDenied();
      await access.requireRecord(parent, exact);
    } else if (LIST_PARENTS[model]) await access.requireRecord(LIST_PARENTS[model].model, exact);
    else await access.requireAccount(exact);
    if (model === "Account" || naturalKey(model)) {
      const record = await access.get(model, exact); await append(record ? [record] : []); done = true;
    } else while (withinBudget()) {
      const page = await readPage(model, field, exact, limit - items.length, c.records, filter);
      c.records = page.cursor; await append(page.items);
      if (!page.cursor) { done = true; break; }
    }
    return finish();
  }
  const migration = await access.get("Communication", "migration:assignment-index:v1");
  if (object(migration?.data).complete !== true) throw new Error("Account access is being prepared. Please try again shortly.");
  const advanceAccount = () => { delete c.account; delete c.parents; delete c.parent; delete c.parentIds; delete c.records; c.part = 0; };
  const advanceParent = () => {
    delete c.parent; delete c.records;
    if (!c.parents && !c.parentIds?.length) {
      delete c.parentIds;
      if (model === "Document" && c.part < documentParents.length - 1) c.part++;
      else advanceAccount();
    }
  };
  const finished = () => !c.account && !c.accounts?.length && c.owner >= owners.length && (model !== "Document" || c.shared >= sharedDocuments.length);
  while (withinBudget() && !finished()) {
    if (!c.account) {
      if (c.accounts?.length) { c.account = c.accounts.shift(); continue; }
      if (c.owner < owners.length) {
        const page = await readPage("Communication", "assignedSalespersonId", owners[c.owner], Math.min(limit - items.length, 25), c.assignment);
        c.assignment = page.cursor;
        if (!page.cursor) c.owner++;
        c.accounts = page.items.map(item => id(item.accountId)).filter(Boolean);
        await access.prefetchAccounts(c.accounts);
        if (model === "Account") {
          const permitted = (await Promise.all(c.accounts.map(async key => await access.canAccount(key) ? { id: key } : undefined))).filter((r): r is { id: string } => !!r);
          await append(permitted); c.accounts = [];
        }
        continue;
      }
      if (model === "Document" && c.shared < sharedDocuments.length) {
        const page = await readPage(model, "entityType", sharedDocuments[c.shared], limit - items.length, c.records, filter);
        c.records = page.cursor; if (!page.cursor) c.shared++;
        await append(page.items);
      }
      continue;
    }
    if (!await access.canAccount(c.account)) { advanceAccount(); continue; }
    if (model === "Account" || naturalKey(model)) {
      const record = await access.get(model, c.account); await append(record ? [record] : []); advanceAccount(); continue;
    }
    const parentModel = model === "Document" ? documentParents[c.part] : LIST_PARENTS[model]?.model;
    if (model === "Document" && !parentModel) throw new AccessDenied();
    if (parentModel && parentModel !== "Account" && !c.parent) {
      // Keep every unvisited parent when the child page or traversal budget
      // ends. The GSI cursor has already advanced past this whole parent page.
      if (!c.parentIds?.length) {
        const page = await readPage(parentModel, "accountId", c.account, parentPageSize, c.parents);
        c.parents = page.cursor; c.parentIds = page.items.map(item => id(item.id)).filter(Boolean);
      }
      c.parent = c.parentIds.shift();
      if (!c.parent && !c.parents) advanceParent();
      continue;
    }
    if (c.parent) {
      // Cursor IDs and GSI projections are hints only. Batch current parents,
      // then retain the same authorization/root checks. Cap read-ahead by the
      // remaining output slots so small pages do not reread the whole queue.
      await access.prefetch(parentModel!, [c.parent, ...(c.parentIds ?? [])].slice(0, limit - items.length));
      try {
        const parent = await access.requireRecord(parentModel!, c.parent);
        if (await access.root(parentModel!, parent) !== c.account) throw new AccessDenied();
      } catch (error) {
        if (!(error instanceof AccessDenied)) throw error;
        // Deleted, reassigned or moved parent from a lagging GSI/cursor. Skip
        // its remaining children but preserve the next parent/account position.
        advanceParent(); continue;
      }
    }
    const page = await readPage(model, field, c.parent ?? c.account, limit - items.length, c.records, filter);
    c.records = page.cursor; if (!page.cursor) advanceParent();
    await append(page.items);
  }
  done = finished();
  return finish();
}
