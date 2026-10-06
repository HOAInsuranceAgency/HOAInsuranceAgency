import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { ACCOUNT_MODELS, ACCOUNT_REFERENCES, LIST_PARENTS, SHARED_MODELS, RETIRED_MODELS, AccessDenied, id, object, type Identity, type RecordData } from "./policy";
import { isActiveAdmin, type RoleRequest } from "./active-role";
export const db = DynamoDBDocumentClient.from(new DynamoDBClient());
export function tableName(model: string) {
  const tables = JSON.parse(process.env.ACCESS_TABLES ?? "{}") as Record<string, string>;
  const name = model === "Communication" ? process.env.COMMUNICATION_TABLE : tables[model] ?? (process.env.ACCESS_API_ID && `${model}-${process.env.ACCESS_API_ID}-NONE`);
  if (!name) throw new Error("Account access is not configured");
  return name;
}
const primaryKey = (model: string) => ["GlApplication", "DoApplication"].includes(model) ? "accountId" : "id";
export type Reader = (model: string, key: string) => Promise<RecordData | undefined>;
const read: Reader = async (model, key) => {
  return (await db.send(new GetCommand({ TableName: tableName(model), Key: { [primaryKey(model)]: key }, ConsistentRead: true }))).Item;
};
/** Share the canonical parent mapping between single-record and batched checks.
 * Writable accountId mirrors on indirect records are never authoritative. */
function recordParent(model: string, value: RecordData) {
  if (model === "Document") {
    const parent = ({ ACCOUNT: "Account", QUOTE: "Quote", POLICY: "Policy", CERTIFICATE: "Certificate", CARRIER: "Carrier", LICENSE: "License", USER_PROFILE: "UserProfile" } as Record<string, string>)[id(value.entityType)];
    const key = id(value.entityId);
    if (!parent || !key) throw new AccessDenied();
    return { model: parent, key };
  }
  const parent = LIST_PARENTS[model];
  return parent ? { model: parent.model, key: id(value[parent.field]) } : undefined;
}
/** Cache only within one request: reassignments apply on the next request. */
export class AccountAccess {
  readonly actor: string;
  readonly admin: boolean;
  private readonly records = new Map<string, Promise<RecordData | undefined>>();
  constructor(identity: Identity | undefined, private readonly reader: Reader = read, request?: RoleRequest) {
    this.actor = id(identity?.sub); if (!this.actor) throw new AccessDenied();
    this.admin = isActiveAdmin(identity, request);
  }
  get(model: string, key: string) {
    if (!key) return Promise.resolve(undefined);
    const cacheKey = `${model}:${key}`;
    if (!this.records.has(cacheKey)) this.records.set(cacheKey, this.reader(model, key));
    return this.records.get(cacheKey)!;
  }
  async prefetch(model: string, keys: string[]) {
    const missing = [...new Set(keys)].filter(key => key && !this.records.has(`${model}:${key}`));
    if (!missing.length) return;
    if (this.reader !== read) { await Promise.all(missing.map(key => this.get(model, key))); return; }
    const name = tableName(model), keyField = primaryKey(model);
    for (let offset = 0; offset < missing.length; offset += 100) {
      const batch = missing.slice(offset, offset + 100);
      let pending = { [name]: { Keys: batch.map(key => ({ [keyField]: key })), ConsistentRead: true } };
      const found = new Map<string, RecordData>();
      for (let attempt = 0; Object.keys(pending).length; attempt++) {
        if (attempt === 4) throw new Error("Account access lookup is busy; please retry");
        const result = await db.send(new BatchGetCommand({ RequestItems: pending }));
        for (const item of result.Responses?.[name] ?? []) found.set(id(item[keyField]), item);
        pending = result.UnprocessedKeys as typeof pending ?? {};
        if (Object.keys(pending).length) await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
      }
      for (const key of batch) this.records.set(`${model}:${key}`, Promise.resolve(found.get(key)));
    }
  }
  async prefetchAccounts(keys: string[]) {
    if (this.admin) return;
    await this.prefetch("Communication", keys.filter(Boolean).flatMap(key => [`workflow:${key}`, `deleted-account:${key}`]));
  }
  async prefetchRecordAccess(model: string, values: RecordData[]) {
    if (this.admin) return;
    const parents = new Map<string, string[]>();
    for (const value of values) {
      try {
        const parent = recordParent(model, value);
        if (parent) {
          const keys = parents.get(parent.model) ?? [];
          keys.push(parent.key); parents.set(parent.model, keys);
        }
      } catch (error) { if (!(error instanceof AccessDenied)) throw error; }
    }
    // Every supported canonical parent has a direct account/shared root. Load
    // each parent model in batches before resolving roots from the local cache.
    await Promise.all([...parents].map(([parentModel, keys]) => this.prefetch(parentModel, keys)));
    const roots = await Promise.all(values.map(async value => {
      try { return await this.root(model, value); }
      catch (error) { if (error instanceof AccessDenied) return null; throw error; }
    }));
    await this.prefetchAccounts(roots.filter((root): root is string => !!root));
  }
  async salespeople() {
    // Legacy routing/manager/coverage settings never grant record access.
    // Administrators bypass assignment checks; everyone else sees only self.
    return new Set([this.actor]);
  }
  async canAccount(accountId: string) {
    if (!accountId) return false;
    if (this.admin) return true;
    if (await this.get("Communication", `deleted-account:${accountId}`)) return false;
    const workflow = object((await this.get("Communication", `workflow:${accountId}`))?.data);
    return id(workflow.salespersonId) === this.actor;
  }
  async requireAccount(accountId: string) { if (!await this.canAccount(accountId)) throw new AccessDenied(); }
  async requireSalesperson(salespersonId: string) {
    if (!this.admin && salespersonId !== this.actor) throw new AccessDenied();
  }
  async root(model: string, value: RecordData, depth = 0): Promise<string | null> {
    if (depth > 5) throw new AccessDenied();
    if ((SHARED_MODELS as readonly string[]).includes(model)) return null;
    if (!(ACCOUNT_MODELS as readonly string[]).includes(model)) throw new AccessDenied();
    if (model === "Account") return id(value.id);
    if (model === "Activity") return id(value.entityId);
    const parent = recordParent(model, value);
    if (parent) {
      const target = await this.get(parent.model, parent.key); if (!target) throw new AccessDenied();
      return this.root(parent.model, target, depth + 1);
    }
    return id(value.accountId);
  }
  async canRecord(model: string, value: RecordData) {
    if (RETIRED_MODELS.includes(model)) return false;
    if (this.admin) return true;
    try { const root = await this.root(model, value); return root === null || await this.canAccount(root); }
    catch (error) { if (error instanceof AccessDenied) return false; throw error; }
  }
  async requireRecord(model: string, key: string) {
    const value = await this.get(model, key);
    if (!value || !await this.canRecord(model, value)) throw new AccessDenied();
    return value;
  }
  async write(model: string, operation: string, input: RecordData) {
    if (RETIRED_MODELS.includes(model)) throw new AccessDenied();
    // Field-level delete grants are required for whole-account deletion, but
    // Amplify also uses them to authorize clearing fields in an update. Keep
    // acquisition immutable for every browser role, including administrators.
    if (model === "Account" && ["create", "update"].includes(operation)
      && ["source", "leadSource", "leadAttribution"].some(field => Object.hasOwn(input, field))) throw new AccessDenied();
    if (this.admin) return;
    const key = id(["GlApplication", "DoApplication"].includes(model) ? input.accountId : input.id);
    const old = key ? await this.get(model, key) : undefined;
    if (operation !== "create" && !old || old && !await this.canRecord(model, old)) throw new AccessDenied();
    if (model === "UserProfile") {
      if ((old?.userId ?? input.userId) !== this.actor || input.userId != null && input.userId !== this.actor) throw new AccessDenied();
    }
    if (operation === "delete") return;
    const candidate = { ...old, ...input };
    if (!await this.canRecord(model, candidate)) throw new AccessDenied();
    const root = await this.root(model, candidate);
    if (candidate.accountId && root && candidate.accountId !== root) throw new AccessDenied();
    for (const [field, targetModel] of Object.entries(ACCOUNT_REFERENCES[model] ?? {})) {
      if (!candidate[field]) continue;
      const target = await this.requireRecord(targetModel, id(candidate[field]));
      if (root && await this.root(targetModel, target) !== root) throw new AccessDenied();
    }
    if (Array.isArray(candidate.policyIds)) for (const policyId of candidate.policyIds) {
      const policy = await this.requireRecord("Policy", id(policyId));
      if (root !== await this.root("Policy", policy)) throw new AccessDenied();
    }
    if (candidate.sourceCommunicationId) {
      const source = await this.get("Communication", id(candidate.sourceCommunicationId));
      const sourceAccount = id(source?.accountId) || id(object(source?.data).accountId);
      if (!sourceAccount || sourceAccount !== root) throw new AccessDenied();
    }
    for (const key of ["s3Key", "coverPhotoKey", "aerialPhotoKey", "plotPlanKey", "signatureKey"]) {
      if (typeof candidate[key] === "string" && candidate[key] && candidate[key] !== "pending") await this.path(String(candidate[key]), "link", root);
    }
  }
  async path(path: string, operation: "read" | "write" | "delete" | "link", expectedRoot?: string | null) {
    if (!path || path.length > 1024 || /[\\\x00-\x1f]/.test(path) || path.split("/").some(p => p === "." || p === ".." || !p)) throw new AccessDenied();
    const [prefix, first, second, docId] = path.split("/");
    if (prefix === "documents") {
      const scope = { entityType: first, entityId: second };
      if (expectedRoot && await this.root("Document", scope) !== expectedRoot) throw new AccessDenied();
      if (!await this.canRecord("Document", scope)) throw new AccessDenied();
      const document = docId ? await this.get("Document", docId) : undefined;
      if (operation === "delete" && !document) return; // Failed uploads and deletion cleanup.
      if (!document || document.entityType !== first || document.entityId !== second) throw new AccessDenied();
      if (operation === "read" && document.s3Key !== path) throw new AccessDenied();
      return;
    }
    if (prefix === "generated" && first === "pf") {
      const loan = await this.requireRecord("PfLoan", second);
      if (path !== `generated/pf/${id(loan.id)}/premium-finance-agreement.pdf` || !["read", "link"].includes(operation)) throw new AccessDenied();
      if (expectedRoot && loan.accountId !== expectedRoot) throw new AccessDenied();
      return; // Only the agreement service may create, replace, or delete this file.
    }
    if (["certificates", "generated", "property-photos"].includes(prefix)) {
      const account = first;
      if (expectedRoot && account !== expectedRoot) throw new AccessDenied();
      await this.requireAccount(account);
      if (path.split("/").length !== 3) throw new AccessDenied();
      if (prefix === "certificates") {
        const certificate = await this.get("Certificate", second.replace(/\.pdf$/, ""));
        if (operation === "delete" && this.admin && !certificate) return;
        if (!certificate || certificate.accountId !== account || second !== `${id(certificate.id)}.pdf` || operation === "delete" && !this.admin) throw new AccessDenied();
        if (operation === "read" && certificate.s3Key !== path) throw new AccessDenied();
      }
      if (prefix === "property-photos") {
        if (!/^(coverPhotoKey|aerialPhotoKey|plotPlanKey)-.+$/.test(second)) throw new AccessDenied();
        const record = await this.requireRecord("Account", account);
        if (operation === "read" && ![record.coverPhotoKey, record.aerialPhotoKey, record.plotPlanKey].includes(path)) throw new AccessDenied();
      }
      return;
    }
    if (prefix === "templates") { if (!["read", "link"].includes(operation) && !this.admin) throw new AccessDenied(); return; }
    if (prefix === "signatures") {
      const profileId = first?.replace(/\.[^.]+$/, "");
      const profile = await this.get("UserProfile", profileId);
      if (path.split("/").length !== 2 || !profile || !this.admin && profile.userId !== this.actor) throw new AccessDenied();
      return;
    }
    throw new AccessDenied();
  }
}
