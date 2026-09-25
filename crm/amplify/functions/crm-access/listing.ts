import { createHash } from "node:crypto";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AccountAccess, db, tableName } from "./access";
import { ACCOUNT_MODELS, LIST_PARENTS, AccessDenied, id, listPartition, object, type RecordData } from "./policy";

/** DynamoDB model filters are evaluated only inside an authorized partition.
 * Keeping the predicate here also supports filters on the partition key itself,
 * which DynamoDB rejects in a Query FilterExpression. */
export function matchesFilter(record: RecordData, filter: RecordData): boolean {
  return Object.entries(filter).every(([field, condition]) => {
    if (condition == null) return true;
    if (field === "and" || field === "or") {
      if (!Array.isArray(condition)) throw new Error("Invalid list filter");
      return field === "and" ? condition.every(f => matchesFilter(record, object(f))) : condition.some(f => matchesFilter(record, object(f)));
    }
    if (field === "not") return !matchesFilter(record, object(condition));
    return Object.entries(object(condition)).every(([op, expected]) => {
      const value = record[field];
      const contains = () => typeof value === "string" && typeof expected === "string" ? value.includes(expected) : Array.isArray(value) && value.includes(expected);
      const compare = (bound: unknown) => typeof value === "string" && typeof bound === "string" || typeof value === "number" && typeof bound === "number"
        ? value === bound ? 0 : (value as string | number) < (bound as string | number) ? -1 : 1 : undefined;
      switch (op) {
        case "eq": return (value ?? null) === expected;
        case "ne": return (value ?? null) !== expected;
        case "lt": return compare(expected) === -1;
        case "le": return compare(expected) === -1 || compare(expected) === 0;
        case "gt": return compare(expected) === 1;
        case "ge": return compare(expected) === 1 || compare(expected) === 0;
        case "between": return Array.isArray(expected) && [0, 1].includes(compare(expected[0]) ?? -2) && [-1, 0].includes(compare(expected[1]) ?? -2);
        case "contains": return contains();
        case "notContains": return value != null && !contains();
        case "beginsWith": return typeof value === "string" && typeof expected === "string" && value.startsWith(expected);
        case "attributeExists": return (value !== undefined) === expected;
        case "attributeType": return ({ S: typeof value === "string", N: typeof value === "number", BOOL: typeof value === "boolean", NULL: value === null, L: Array.isArray(value), M: value != null && typeof value === "object" && !Array.isArray(value) } as Record<string, boolean>)[String(expected)] === true;
        case "size": return value != null && (typeof value === "string" || Array.isArray(value)) && matchesFilter({ size: typeof value === "string" ? Buffer.byteLength(value) : value.length }, { size: expected });
        default: throw new Error("Unsupported list filter");
      }
    });
  });
}

type Key = Record<string, unknown>;
type Cursor = { scope: string; owner: number; assignment?: Key; account?: string; part: number; parent?: string; parents?: Key; records?: Key; shared: number };
const sharedDocuments = ["CARRIER", "LICENSE", "USER_PROFILE"];
const documentParents = ["Account", "Quote", "Policy", "Certificate"];
const naturalKey = (model: string) => ["GlApplication", "DoApplication"].includes(model);
async function query(model: string, field: string, key: string, limit: number, cursor?: Key) {
  const indexes = JSON.parse(process.env.ACCESS_INDEXES ?? "{}") as Record<string, string>;
  const index = model === "Communication" ? "assignment" : indexes[`${model}.${field}`];
  if (!index) throw new Error(`Missing list index for ${model}.${field}`);
  const page = await db.send(new QueryCommand({ TableName: tableName(model), IndexName: index,
    KeyConditionExpression: "#scope = :scope", ExpressionAttributeNames: { "#scope": field }, ExpressionAttributeValues: { ":scope": key },
    Limit: limit, ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
  return { items: page.Items ?? [], cursor: page.LastEvaluatedKey };
}
function decode(token: unknown, scope: string): Cursor {
  if (token == null) return { scope, owner: 0, part: 0, shared: 0 };
  if (typeof token !== "string" || token.length > 16384) throw new AccessDenied();
  try {
    const c = JSON.parse(Buffer.from(token, "base64url").toString()) as Cursor;
    if (c.scope !== scope || ![c.owner, c.part, c.shared].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error();
    return c;
  } catch { throw new Error("This list changed. Refresh it to continue."); }
}

/** One bounded page, using only assignment and parent indexes. No scan, including
 * for empty/filtered pages. Cursors never grant access: current ownership is
 * checked again before reading a partition and before returning its records. */
export async function listAssigned(access: AccountAccess, model: string, args: RecordData) {
  if (!(ACCOUNT_MODELS as readonly string[]).includes(model) || access.admin) throw new AccessDenied();
  const filter = object(args.filter), owners = [...await access.salespeople()].sort();
  const scope = createHash("sha256").update(JSON.stringify([access.actor, owners, model, filter])).digest("hex");
  const c = decode(args.nextToken, scope), limit = Math.min(100, Math.max(1, Number(args.limit) || 100));
  let items: RecordData[] = [], done = false;
  const finish = async () => {
    // GSI projections can lag a record move/edit. Re-read only the candidate
    // keys in a batch so stale parent fields never authorize a fresh response.
    const keys = items.map(item => id(naturalKey(model) ? item.accountId : item.id)).filter(Boolean);
    await access.prefetch(model, keys);
    items = (await Promise.all(keys.map(key => access.get(model, key)))).filter((r): r is RecordData => !!r);
    const permitted = await Promise.all(items.map(async item => matchesFilter(item, filter) && await access.canRecord(model, item) ? item : undefined));
    return { items: permitted.filter(Boolean), nextToken: done ? null : Buffer.from(JSON.stringify(c)).toString("base64url") };
  };
  // A list already anchored to a parent needs no assignment enumeration.
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
      const record = await access.get(model, exact); items = record ? [record] : []; done = true;
    } else {
      const page = await query(model, field, exact, limit, c.records); items = page.items; c.records = page.cursor; done = !page.cursor;
    }
    return finish();
  }
  const migration = await access.get("Communication", "migration:assignment-index:v1");
  if (object(migration?.data).complete !== true) throw new Error("Account access is being prepared. Please try again shortly.");
  if (!c.account && c.owner < owners.length) {
    const page = await query("Communication", "assignedSalespersonId", owners[c.owner], model === "Account" ? Math.min(limit, 25) : 1, c.assignment);
    c.assignment = page.cursor;
    if (!page.cursor) c.owner++;
    const accountIds = page.items.map(item => id(item.accountId)).filter(Boolean);
    await access.prefetchAccounts(accountIds);
    if (model === "Account") {
      const permitted = (await Promise.all(accountIds.map(async key => await access.canAccount(key) ? key : ""))).filter(Boolean);
      await access.prefetch("Account", permitted);
      items = (await Promise.all(permitted.map(key => access.get("Account", key)))).filter((r): r is RecordData => !!r);
      done = c.owner >= owners.length; return finish();
    }
    c.account = accountIds[0];
  }
  const advanceAccount = () => { delete c.account; delete c.parents; delete c.parent; delete c.records; c.part = 0; };
  if (c.account) {
    // A stale GSI entry after reassignment is skipped, never trusted.
    if (!await access.canAccount(c.account)) advanceAccount();
    else if (naturalKey(model)) {
      const record = await access.get(model, c.account); items = record ? [record] : []; advanceAccount();
    } else {
      const parentModel = model === "Document" ? documentParents[c.part] : LIST_PARENTS[model]?.model;
      if (model === "Document" && !parentModel) throw new AccessDenied();
      if (parentModel && parentModel !== "Account" && !c.parent) {
        const page = await query(parentModel, "accountId", c.account, 1, c.parents);
        c.parents = page.cursor; c.parent = id(page.items[0]?.id) || undefined;
        if (!c.parent && !c.parents) {
          if (model === "Document" && c.part < documentParents.length - 1) c.part++;
          else advanceAccount();
        }
      }
      if (c.account && (!parentModel || parentModel === "Account" || c.parent)) {
        const partition = c.parent ?? c.account;
        if (c.parent) {
          const parent = await access.requireRecord(parentModel!, c.parent);
          if (await access.root(parentModel!, parent) !== c.account) throw new AccessDenied();
        }
        const page = await query(model, field, partition, limit, c.records); items = page.items; c.records = page.cursor;
        if (!page.cursor) {
          delete c.parent;
          if (!c.parents) {
            if (model === "Document" && c.part < documentParents.length - 1) c.part++;
            else advanceAccount();
          }
        }
      }
    }
  } else if (c.owner >= owners.length && model === "Document" && c.shared < sharedDocuments.length) {
    const page = await query(model, "entityType", sharedDocuments[c.shared], limit, c.records);
    items = page.items; c.records = page.cursor; if (!page.cursor) c.shared++;
  }
  done = !c.account && c.owner >= owners.length && (model !== "Document" || c.shared >= sharedDocuments.length);
  return finish();
}
