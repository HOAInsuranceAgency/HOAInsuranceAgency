import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ACCOUNT_MODELS, ACCOUNT_REFERENCES, SHARED_MODELS, AccessDenied, id, object, type Identity, type RecordData } from "./policy";
const db = DynamoDBDocumentClient.from(new DynamoDBClient());
export type Reader = (model: string, key: string) => Promise<RecordData | undefined>;
const read: Reader = async (model, key) => {
  const tables = JSON.parse(process.env.ACCESS_TABLES ?? "{}") as Record<string, string>;
  const TableName = model === "Communication" ? process.env.COMMUNICATION_TABLE : tables[model];
  if (!TableName) throw new Error("Account access is not configured");
  return (await db.send(new GetCommand({ TableName, Key: { [["GlApplication", "DoApplication"].includes(model) ? "accountId" : "id"]: key }, ConsistentRead: true }))).Item;
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
    if (["certificates", "generated", "property-photos"].includes(prefix)) {
      const account = prefix === "generated" && first === "pf"
        ? id((await this.requireRecord("PfLoan", second)).accountId) : first;
      if (expectedRoot && account !== expectedRoot) throw new AccessDenied();
      await this.requireAccount(account); return;
    }
    if (prefix === "templates") { if (!["read", "link"].includes(operation) && !this.admin) throw new AccessDenied(); return; }
    if (prefix === "signatures") {
      const profileId = first?.replace(/\.[^.]+$/, "");
      const profile = await this.get("UserProfile", profileId);
      if (!profile || operation !== "read" && !this.admin && profile.userId !== this.actor) throw new AccessDenied();
      return;
    }
    throw new AccessDenied();
  }
}
