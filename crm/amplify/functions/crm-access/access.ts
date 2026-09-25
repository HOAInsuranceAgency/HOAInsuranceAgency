import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { ACCOUNT_MODELS, ACCOUNT_REFERENCES, SHARED_MODELS, AccessDenied, id, object, type Identity, type RecordData } from "./policy";
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
/** Cache only within one request: reassignments and manager edits apply on the next request. */
export class AccountAccess {
  readonly actor: string;
  readonly admin: boolean;
  private readonly records = new Map<string, Promise<RecordData | undefined>>();
  constructor(identity: Identity | undefined, private readonly reader: Reader = read) {
    this.actor = id(identity?.sub); if (!this.actor) throw new AccessDenied();
    const groups = identity?.groups ?? identity?.claims?.["cognito:groups"];
    this.admin = Array.isArray(groups) && groups.includes("ADMIN");
  }
  get(model: string, key: string) {
    if (!key) return Promise.resolve(undefined);
    const cacheKey = `${model}:${key}`;
    if (!this.records.has(cacheKey)) this.records.set(cacheKey, this.reader(model, key));
    return this.records.get(cacheKey)!;
  }
  async prefetch(model: string, keys: string[]) {
    const missing = [...new Set(keys)].filter(key => key && !this.records.has(`${model}:${key}`));
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
    await this.prefetch("Communication", keys.flatMap(key => [`workflow:${key}`, `deleted-account:${key}`]));
  }
  async team() {
    const saved = await this.get("Communication", "team-routing");
    const members = object(saved?.data).members;
    return Array.isArray(members) ? members.map(object) : [];
  }
  async salespeople() {
    const members = await this.team();
    const manager = members.some(m => m.userId === this.actor && m.salesManager === true);
    return new Set([this.actor, ...(manager ? members.filter(m => m.salesManagerId === this.actor).map(m => id(m.userId)).filter(Boolean) : [])]);
  }
  async canAccount(accountId: string) {
    if (!accountId) return false;
    if (this.admin) return true;
    if (await this.get("Communication", `deleted-account:${accountId}`)) return false;
    const workflow = object((await this.get("Communication", `workflow:${accountId}`))?.data);
    return (await this.salespeople()).has(id(workflow.salespersonId));
  }
  async requireAccount(accountId: string) { if (!await this.canAccount(accountId)) throw new AccessDenied(); }
  async requireSalesperson(salespersonId: string) {
    if (!this.admin && !(await this.salespeople()).has(salespersonId)) throw new AccessDenied();
  }
  async root(model: string, value: RecordData, depth = 0): Promise<string | null> {
    if (depth > 5) throw new AccessDenied();
    if ((SHARED_MODELS as readonly string[]).includes(model)) return null;
    if (!(ACCOUNT_MODELS as readonly string[]).includes(model)) throw new AccessDenied();
    if (model === "Account") return id(value.id);
    if (model === "Activity") return id(value.entityId);
    if (model === "Document") {
      const type = id(value.entityType), key = id(value.entityId);
      const parent = ({ ACCOUNT: "Account", QUOTE: "Quote", POLICY: "Policy", CERTIFICATE: "Certificate", CARRIER: "Carrier", LICENSE: "License", USER_PROFILE: "UserProfile" } as Record<string, string>)[type];
      if (!parent || !key) throw new AccessDenied();
      const target = await this.get(parent, key); if (!target) throw new AccessDenied();
      return this.root(parent, target, depth + 1);
    }
    // Derive indirect roots from their authoritative parent, not a writable mirror.
    const parent = model === "InvoiceLine" ? ["Invoice", id(value.invoiceId)] : ["PfLoanPayment", "PfNotice"].includes(model) ? ["PfLoan", id(value.loanId)] : model === "PfOverride" ? ["Policy", id(value.policyId)] : undefined;
    if (parent) {
      const target = await this.get(parent[0], parent[1]); if (!target) throw new AccessDenied();
      return this.root(parent[0], target, depth + 1);
    }
    return id(value.accountId);
  }
  async canRecord(model: string, value: RecordData) {
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
