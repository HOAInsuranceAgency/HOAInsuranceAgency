import { beforeEach, describe, expect, it, vi } from "vitest";
const issuedFees = vi.hoisted(() => new Map<string, { issuedInvoiceIds: string[] }>());
vi.mock("../../amplify/functions/broker-fees/store", async original => ({
  ...await original<typeof import("../../amplify/functions/broker-fees/store")>(),
  getFee: async (quoteId: string) => issuedFees.get(quoteId),
  accountModels: async (model:string,accountId:string)=>Object.entries(records).filter(([key,row])=>key.startsWith(`${model}:`)&&row.accountId===accountId).map(([,row])=>row),
  db:{send:async(command:{input:{ExpressionAttributeValues:Record<string,unknown>}})=>({Items:Object.entries(records).filter(([key,row])=>key.startsWith('InvoiceLine:')&&row.invoiceId===command.input.ExpressionAttributeValues[':invoice']).map(([,row])=>({id:row.id}))})},
}));
import { AccountAccess, type Reader } from "../../amplify/functions/crm-access/access";
import { authorizeCustom, filterCustom } from "../../amplify/functions/crm-access/custom";
import { ACCOUNT_MODELS, RETIRED_MODELS, AccessDenied, type RecordData } from "../../amplify/functions/crm-access/policy";
import { validateInvoiceSourceCharges } from '../../amplify/functions/send-invoice/passThroughInvoice';
import { invoiceBrokerFeeAllocations } from '../../amplify/functions/send-invoice/brokerFeeInvoice';
let records: Record<string, RecordData>;
const reader: Reader = async (model, key) => records[`${model}:${key}`];
const user = (sub = "alice") => new AccountAccess({ sub }, reader);
const admin = () => new AccountAccess({ sub: "admin", groups: ["ADMIN"] }, reader);
beforeEach(() => {
  issuedFees.clear();
  process.env.ACCESS_INDEXES=JSON.stringify({'InvoiceLine.invoiceId':'original-lines'});
  records = {
    "Communication:team-routing": { data: { members: [{ userId: "manager", salesManager: true }, { userId: "alice", salesManagerId: "manager" }, { userId: "bob", salesManagerId: "other-manager" }] } },
    "Communication:workflow:a": { data: { salespersonId: "alice" } },
    "Communication:workflow:b": { data: { salespersonId: "bob" } },
    "Account:a": { id: "a", coverPhotoKey: "property-photos/a/coverPhotoKey-cover.jpg" }, "Account:b": { id: "b" },
    "Certificate:cert": { id: "cert", accountId: "a", s3Key: "certificates/a/cert.pdf" },
    "Quote:qa": { id: "qa", accountId: "a" }, "Quote:qb": { id: "qb", accountId: "b" },
    "Policy:pa": { id: "pa", accountId: "a" }, "Policy:pb": { id: "pb", accountId: "b" },
    "Invoice:ia": { id: "ia", accountId: "a" }, "Invoice:ib": { id: "ib", accountId: "b" },
    "PfLoan:la": { id: "la", accountId: "a" }, "PfLoan:lb": { id: "lb", accountId: "b" },
    "Document:da": { id: "da", entityType: "ACCOUNT", entityId: "a", s3Key: "documents/ACCOUNT/a/da/file.pdf" },
    "Document:db": { id: "db", entityType: "ACCOUNT", entityId: "b", s3Key: "documents/ACCOUNT/b/db/file.pdf" },
    "UserProfile:alice-profile": { id: "alice-profile", userId: "alice", role: "ADMIN" },
    "UserProfile:bob-profile": { id: "bob-profile", userId: "bob" },
    "Carrier:carrier": { id: "carrier" },
    "Communication:task:a": { accountId: "a", data: { accountId: "a" } },
    "Communication:task:b": { accountId: "b", data: { accountId: "b" } },
    "Communication:front-link:cnv_a": { accountId: "a", data: { accountId: "a" } },
    "Communication:front-link:cnv_b": { accountId: "b", data: { accountId: "b" } },
    "HoneycombEstimate:ea": { id: "ea", accountId: "a" }, "HoneycombEstimate:eb": { id: "eb", accountId: "b" },
  };
});
describe("current account assignment", () => {
  it('authorizes carrier payment previews only through an accessible quote', async () => {
    await expect(authorizeCustom(user(), 'carrierPaymentPreview', { quoteId: 'qa', billType: 'DIRECT' })).resolves.toBeUndefined();
    await expect(authorizeCustom(user(), 'carrierPaymentPreview', { quoteId: 'qb', billType: 'DIRECT' })).rejects.toThrow(AccessDenied);
    await expect(authorizeCustom(user(), 'carrierPaymentPreview', { quoteId: 'missing', billType: 'DIRECT' })).rejects.toThrow(AccessDenied);
  });
  it("limits salespeople to their accounts, including direct guessed IDs", async () => {
    expect(await user().canAccount("a")).toBe(true);
    expect(await user().canAccount("b")).toBe(false);
    await expect(user().requireRecord("Account", "b")).rejects.toBeInstanceOf(AccessDenied);
    expect(await user().canAccount("unassigned")).toBe(false);
    expect(await admin().canAccount("unassigned")).toBe(true);
  });
  it("ignores every retired manager, agency-owner and coverage grant", async () => {
    records["Communication:team-routing"].data = {
      ownerId: "owner", intakeOwnerId: "intake", integrationOwnerId: "integration",
      members: [{ userId: "manager", salesManager: true }, { userId: "alice", salesManagerId: "manager", coverId: "cover", away: true }],
    };
    for (const actor of ["manager", "owner", "intake", "integration", "cover"]) {
      expect(await user(actor).salespeople()).toEqual(new Set([actor]));
      expect(await user(actor).canAccount("a")).toBe(false);
      await expect(user(actor).requireRecord("Account", "a")).rejects.toThrow(AccessDenied);
      await expect(user(actor).requireSalesperson("alice")).rejects.toThrow(AccessDenied);
    }
    records["Communication:workflow:owned"] = { data: { salespersonId: "manager" } };
    expect(await user("manager").canAccount("owned")).toBe(true);
    expect(await admin().canAccount("a")).toBe(true);
    await expect(admin().requireSalesperson("alice")).resolves.toBeUndefined();
  });
  it("does not accept the self-editable profile role as authority", async () => {
    expect(user().admin).toBe(false);
    expect(await user().canAccount("b")).toBe(false);
    expect(new AccountAccess({ sub: "admin", claims: { "cognito:groups": ["ADMIN"] } }, reader).admin).toBe(true);
    expect(() => new AccountAccess(undefined, reader)).toThrow(AccessDenied);
  });
  it("inherits account, assignment and file administration for Owner without paired Admin membership", async () => {
    const owner = new AccountAccess({ sub: "owner", groups: ["OWNER", "PRODUCER"] }, reader);
    expect(owner.admin).toBe(true);
    expect(await owner.canAccount("b")).toBe(true);
    await expect(owner.path("templates/acord.pdf", "write")).resolves.toBeUndefined();
    await expect(authorizeCustom(owner, "communicationWrite", { operation: "setResponsibilities", input: { accountId: "b", salespersonId: "alice" } })).resolves.toBeUndefined();
    const narrowed = new AccountAccess({ sub: "owner", groups: ["OWNER", "PRODUCER"] }, reader, { headers: { "x-crm-role": "PRODUCER" } });
    expect(narrowed.admin).toBe(false);
    expect(await narrowed.canAccount("b")).toBe(false);
    await expect(narrowed.path("templates/acord.pdf", "write")).rejects.toThrow(AccessDenied);
    expect(() => new AccountAccess({ sub: "admin", groups: ["ADMIN"] }, reader, { headers: { "x-crm-role": "OWNER" } })).toThrow(AccessDenied);
  });
  it("rechecks reassignment on the next request without consulting obsolete manager changes", async () => {
    expect(await user().canAccount("a")).toBe(true);
    records["Communication:workflow:a"] = { data: { salespersonId: "bob" } };
    expect(await user().canAccount("a")).toBe(false);
    expect(await user("manager").canAccount("a")).toBe(false);
    expect(await user("bob").canAccount("a")).toBe(true);
    records["Communication:team-routing"].data = { members: [{ userId: "manager", salesManager: true }, { userId: "bob", salesManagerId: "manager" }] };
    expect(await user("manager").canAccount("a")).toBe(false);
  });
  it("hides retired accounts and denies records without an assignment", async () => {
    records["Communication:deleted-account:a"] = { id: "deleted-account:a" };
    expect(await user().canAccount("a")).toBe(false);
    delete records["Communication:workflow:b"];
    expect(await user("bob").canAccount("b")).toBe(false);
  });
  it("does not turn storage failures into access", async () => {
    const broken = new AccountAccess({ sub: "alice" }, async () => { throw new Error("offline"); });
    await expect(broken.canRecord("Account", { id: "a" })).rejects.toThrow("offline");
  });
});
describe("all related models", () => {
  const record = (model: string, suffix: string) => {
    if (model === "Account") return { id: suffix };
    if (model === "Activity") return { entityId: suffix };
    if (model === "Document") return { entityType: "ACCOUNT", entityId: suffix };
    if (model === "InvoiceLine") return { invoiceId: `i${suffix}`, accountId: "a" };
    if (["PfNotice", "PfLoanPayment"].includes(model)) return { loanId: `l${suffix}`, accountId: "a" };
    if (model === "PfOverride") return { policyId: `p${suffix}` };
    return { accountId: suffix };
  };
  it.each(ACCOUNT_MODELS.filter(model => !RETIRED_MODELS.includes(model)))("checks %s through its authoritative account", async model => {
    expect(await user().canRecord(model, record(model, "a"))).toBe(true);
    expect(await user().canRecord(model, record(model, "b"))).toBe(false);
    expect(await user("manager").canRecord(model, record(model, "a"))).toBe(false);
    expect(await admin().canRecord(model, record(model, "a"))).toBe(true);
  });
  it("derives quote/policy documents from the parent and retains shared carrier files", async () => {
    expect(await user().canRecord("Document", { entityType: "POLICY", entityId: "pb" })).toBe(false);
    expect(await user().canRecord("Document", { entityType: "QUOTE", entityId: "qa" })).toBe(true);
    expect(await user().canRecord("Document", { entityType: "CARRIER", entityId: "carrier" })).toBe(true);
    expect(await user().canRecord("Document", { entityType: "UNKNOWN", entityId: "a" })).toBe(false);
  });
  it("fails closed for unknown models and malformed or orphaned records", async () => {
    expect(await user().canRecord("Unknown", { accountId: "a" })).toBe(false);
    expect(await user().canRecord("Quote", {})).toBe(false);
    expect(await user().canRecord("InvoiceLine", { invoiceId: "gone", accountId: "a" })).toBe(false);
  });
});
describe("model writes", () => {
  it.each(["create", "update", "delete"])("rejects %s on a foreign record", async operation => {
    await expect(user().write("Quote", operation, { id: "qb", accountId: "b" })).rejects.toThrow(AccessDenied);
  });
  it("prevents claiming an existing record by changing its parent", async () => {
    await expect(user().write("Quote", "update", { id: "qb", accountId: "a" })).rejects.toThrow(AccessDenied);
    await expect(user().write("Quote", "update", { id: "qa", accountId: "b" })).rejects.toThrow(AccessDenied);
    await expect(user().write("Quote", "create", { id: "qb", accountId: "a" })).rejects.toThrow(AccessDenied);
    await expect(user().write("Quote", "update", { id: "qa", premium: 1000 })).resolves.toBeUndefined();
  });
  it("requires secondary references to be on the same account even when both accounts are assigned to the actor", async () => {
    records["Communication:workflow:b"] = { data: { salespersonId: "alice" } };
    await expect(user().write("Document", "update", { id: "da", policyId: "pb" })).rejects.toThrow(AccessDenied);
    await expect(user().write("Document", "update", { id: "da", policyId: "pa" })).resolves.toBeUndefined();
  });
  it("checks natural accountId keys and the existing parent before delete", async () => {
    records["GlApplication:a"] = { accountId: "a" };
    records["GlApplication:b"] = { accountId: "b" };
    await expect(user().write("GlApplication", "update", { accountId: "a" })).resolves.toBeUndefined();
    await expect(user().write("GlApplication", "delete", { accountId: "b" })).rejects.toThrow(AccessDenied);
  });
  it("rejects cross-account certificate policies and communication links", async () => {
    await expect(user().write("Certificate", "create", { accountId: "a", policyIds: ["pb"] })).rejects.toThrow(AccessDenied);
    await expect(user().write("Document", "update", { id: "da", sourceCommunicationId: "task:b" })).rejects.toThrow(AccessDenied);
    await expect(user().write("Document", "update", { id: "da", sourceCommunicationId: "task:a" })).resolves.toBeUndefined();
  });
  it("keeps profile writes owned by the signed-in user", async () => {
    await expect(user().write("UserProfile", "update", { id: "bob-profile", firstName: "Changed" })).rejects.toThrow(AccessDenied);
    await expect(user().write("UserProfile", "update", { id: "alice-profile", userId: "bob" })).rejects.toThrow(AccessDenied);
    await expect(user().write("UserProfile", "update", { id: "alice-profile", firstName: "Alice" })).resolves.toBeUndefined();
  });
  it.each(["producer", "admin"])("prevents a %s from bypassing fee invoice closure with a direct status edit", async role => {
    records["Invoice:ia"] = { id: "ia", accountId: "a", status: "SENT", brokerFeeAllocations: JSON.stringify([{ quoteId: "qa", amountCents: 50000 }]), stripePaymentLinkId: "plink-live" };
    const access = role === "admin" ? admin() : user();
    for (const status of ["VOID", "DRAFT", null]) await expect(access.write("Invoice", "update", { id: "ia", status })).rejects.toThrow("invoice payment or void action");
    await expect(access.write("Invoice", "update", { id: "ia", status: "SENT", notes: "Reminder" })).resolves.toBeUndefined();
  });
  it("protects a reserved draft fee invoice before payment-link allocations have been published", async () => {
    records["Invoice:ia"] = { id: "ia", accountId: "a", quoteId: "qa", status: "DRAFT" };
    issuedFees.set("qa", { issuedInvoiceIds: ["ia"] });
    await expect(user().write("Invoice", "update", { id: "ia", status: "VOID" })).rejects.toThrow("invoice payment or void action");
    await expect(admin().write("Invoice", "delete", { id: "ia" })).rejects.toThrow("retain their source and payment history");
  });
  it("resolves a policy invoice's original quote to protect an unpublished fee reservation", async () => {
    records["Invoice:ia"] = { id: "ia", accountId: "a", policyId: "pa", status: "DRAFT" };
    records["Policy:pa"] = { id: "pa", accountId: "a", quoteId: "qa" };
    issuedFees.set("qa", { issuedInvoiceIds: ["ia"] });
    await expect(user().write("Invoice", "update", { id: "ia", status: "VOID" })).rejects.toThrow("invoice payment or void action");
  });
  it.each(["accountId", "quoteId", "policyId"])("cannot detach %s from an issued fee invoice before voiding it", async field => {
    records["Invoice:ia"] = { id: "ia", accountId: "a", quoteId: "qa", policyId: "pa", status: "DRAFT" };
    records["Policy:pa"].quoteId = "qa";
    issuedFees.set("qa", { issuedInvoiceIds: ["ia"] });
    await expect(admin().write("Invoice", "update", { id: "ia", [field]: null })).rejects.toThrow("retain their source and payment history");
  });
  it("protects fee invoices represented by a frozen remittance amount without a quote reference", async () => {
    records["Invoice:ia"] = { id: "ia", accountId: "a", status: "SENT", remittanceBrokerFeeCents: 50000 };
    await expect(admin().write("Invoice", "update", { id: "ia", status: "VOID" })).rejects.toThrow("invoice payment or void action");
    await expect(admin().write("Invoice", "delete", { id: "ia" })).rejects.toThrow("retain their source and payment history");
  });
  it("keeps unissued draft invoice edits and deletion available", async () => {
    records["Invoice:ia"] = { id: "ia", accountId: "a", quoteId: "qa", status: "DRAFT" };
    issuedFees.set("qa", { issuedInvoiceIds: ["another-invoice"] });
    await expect(user().write("Invoice", "update", { id: "ia", notes: "Draft terms", quoteId: null })).resolves.toBeUndefined();
    await expect(user().write("Invoice", "update", { id: "ia", status: "VOID" })).resolves.toBeUndefined();
    await expect(user().write("Invoice", "delete", { id: "ia" })).resolves.toBeUndefined();
  });
  it.each(["create", "update", "delete"])("locks line %s while a draft fee invoice is reserved for publication", async operation => {
    records["Invoice:ia"] = { id: "ia", accountId: "a", quoteId: "qa", status: "DRAFT" };
    records["InvoiceLine:line"] = { id: "line", invoiceId: "ia", accountId: "a", kind: "PREMIUM", retailAmount: 1000 };
    issuedFees.set("qa", { issuedInvoiceIds: ["ia"] });
    const input = operation === "create" ? { id: "new-line", invoiceId: "ia", accountId: "a", kind: "PREMIUM", retailAmount: 100 } : { id: "line", retailAmount: 2000 };
    await expect(user().write("InvoiceLine", operation, input)).rejects.toThrow("Void the issued fee invoice");
    await expect(admin().write("InvoiceLine", operation, input)).rejects.toThrow("Void the issued fee invoice");
  });
  it("does not let a line escape the lock by moving to an unissued draft", async () => {
    records["Invoice:ia"] = { id: "ia", accountId: "a", quoteId: "qa", status: "DRAFT" };
    records["Invoice:unissued"] = { id: "unissued", accountId: "a", status: "DRAFT" };
    records["InvoiceLine:line"] = { id: "line", invoiceId: "ia", accountId: "a", kind: "PREMIUM" };
    issuedFees.set("qa", { issuedInvoiceIds: ["ia"] });
    await expect(user().write("InvoiceLine", "update", { id: "line", invoiceId: "unissued" })).rejects.toThrow("Void the issued fee invoice");
  });
  it("keeps unissued draft invoice lines editable", async () => {
    records["Invoice:ia"] = { id: "ia", accountId: "a", quoteId: "qa", status: "DRAFT" };
    records["InvoiceLine:line"] = { id: "line", invoiceId: "ia", accountId: "a", kind: "PREMIUM" };
    await expect(user().write("InvoiceLine", "create", { id: "new-line", invoiceId: "ia", accountId: "a", kind: "PREMIUM", retailAmount: 100 })).resolves.toBeUndefined();
    await expect(user().write("InvoiceLine", "update", { id: "line", retailAmount: 200 })).resolves.toBeUndefined();
    await expect(user().write("InvoiceLine", "delete", { id: "line" })).resolves.toBeUndefined();
  });
  it('requires agency billing when creating or updating a positive broker fee', async () => {
    await expect(admin().write('Quote', 'create', { id: 'new', accountId: 'a', brokerFee: 500, billType: 'DIRECT' })).rejects.toThrow('Broker fees require agency billing.');
    records['Quote:qa'] = { id: 'qa', accountId: 'a', brokerFee: 500, billType: 'AGENCY' };
    await expect(user().write('Quote', 'update', { id: 'qa', billType: 'DIRECT' })).rejects.toThrow('Broker fees require agency billing.');
    await expect(admin().write('Quote', 'create', { id: 'no-fee', accountId: 'a', brokerFee: 0, billType: 'DIRECT' })).resolves.toBeUndefined();
  });
  it('validates recorded supplier charges and protects bound financial terms with or without HOA fees', async () => {
    const charges = [{ id: 'rt', kind: 'WHOLESALER_FEE', description: 'RT brokerage fee', amountCents: 25000 }];
    await expect(admin().write('Quote', 'update', { id: 'qa', passThroughCharges: '{bad' })).rejects.toThrow();
    records['Quote:qa'] = { id: 'qa', accountId: 'a', status: 'BOUND', passThroughCharges: charges, clientConditions: 'No flat cancellations.' };
    await expect(admin().write('Quote', 'update', { id: 'qa', passThroughCharges: [] })).rejects.toThrow('Bound policy charges');
    records['Policy:pa'] = { id: 'pa', accountId: 'a', passThroughCharges: charges, clientConditions: 'No flat cancellations.' };
    await expect(admin().write('Policy', 'update', { id: 'pa', passThroughCharges: [] })).rejects.toThrow('immutable');
    await expect(admin().write('Policy', 'update', { id: 'pa', clientConditions: 'Different conditions' })).rejects.toThrow('immutable');
    await expect(admin().write('Policy', 'update', { id: 'pa', passThroughCharges: JSON.stringify(charges), clientConditions: 'No flat cancellations.' })).resolves.toBeUndefined();
  });
  it('validates source-backed invoice rows and prevents removing their provenance', async () => {
    const charges = [{ id: 'rt', kind: 'WHOLESALER_FEE', description: 'RT brokerage fee', amountCents: 25000 }];
    records['Quote:qa'] = { id: 'qa', accountId: 'a', passThroughCharges: charges };
    records['Invoice:ia'] = { id: 'ia', accountId: 'a', quoteId: 'qa', status: 'DRAFT' };
    records['InvoiceLine:source'] = { id: 'source', invoiceId: 'ia', accountId: 'a', sourceQuoteChargeId: 'rt', kind: 'WHOLESALER_FEE', description: 'RT brokerage fee', retailAmount: 250, costAmount: 250 };
    await expect(user().write('InvoiceLine', 'update', { id: 'source', retailAmount: 300 })).rejects.toThrow('without agency markup');
    await expect(user().write('InvoiceLine', 'update', { id: 'source', sourceQuoteChargeId: null })).rejects.toThrow('cannot be detached');
    await expect(user().write('InvoiceLine', 'delete', { id: 'source' })).rejects.toThrow('source quote');
    await expect(user().write('InvoiceLine', 'create', { ...records['InvoiceLine:source'], id: 'new' })).resolves.toBeUndefined();
  });
  it('requires provenance on new initial invoices and never lets a browser downgrade or detach it', async () => {
    await expect(admin().write('Invoice', 'create', { id: 'new', accountId: 'a', quoteId: 'qa', status: 'DRAFT' })).rejects.toThrow('source-priced');
    await expect(admin().write('Invoice', 'create', { id: 'new', accountId: 'a', quoteId: 'qa', status: 'DRAFT', sourcePricingVersion: 1 })).resolves.toBeUndefined();
    records['Invoice:ia'] = { id: 'ia', accountId: 'a', quoteId: 'qa', status: 'SENT', sourcePricingVersion: 1, stripePaymentLinkId: 'live' };
    for(const patch of [{ sourcePricingVersion: null }, { sourcePricingVersion: 0 }, { quoteId: null }, { accountId: 'b' }, { status: 'VOID' }])await expect(admin().write('Invoice', 'update', { id: 'ia', ...patch })).rejects.toThrow();
    await expect(admin().write('Invoice', 'delete', { id: 'ia' })).rejects.toThrow('payment history');
    records['InvoiceLine:premium'] = { id: 'premium', invoiceId: 'ia', accountId: 'a', kind: 'PREMIUM', retailAmount: 1000, costAmount: 800 };
    await expect(admin().write('InvoiceLine', 'update', { id: 'premium', retailAmount: 2000 })).rejects.toThrow('Void the issued source-priced invoice');
    await expect(admin().write('InvoiceLine', 'delete', { id: 'premium' })).rejects.toThrow('Void the issued source-priced invoice');
  });
  it('recovers obsolete unissued draft supplier rows without permitting deletion of current charges', async () => {
    records['Quote:qa'] = { id: 'qa', accountId: 'a', passThroughCharges: [] };
    records['Invoice:ia'] = { id: 'ia', accountId: 'a', quoteId: 'qa', status: 'DRAFT', sourcePricingVersion: 1 };
    records['InvoiceLine:obsolete'] = { id: 'obsolete', invoiceId: 'ia', accountId: 'a', sourceQuoteChargeId: 'removed', kind: 'TAX', retailAmount: 10, costAmount: 10 };
    await expect(user().write('InvoiceLine', 'delete', { id: 'obsolete' })).resolves.toBeUndefined();
  });
  it('keeps a published checkout immutable even if invoice email failed and its status remains draft', async () => {
    records['Invoice:ia'] = { id: 'ia', accountId: 'a', quoteId: 'qa', status: 'DRAFT', sourcePricingVersion: 1, stripePaymentLinkId: 'live' };
    records['InvoiceLine:premium'] = { id: 'premium', invoiceId: 'ia', accountId: 'a', kind: 'PREMIUM', retailAmount: 1000, costAmount: 800 };
    await expect(admin().write('InvoiceLine', 'update', { id: 'premium', costAmount: 700 })).rejects.toThrow('Void the issued source-priced invoice');
    await expect(admin().write('InvoiceLine', 'delete', { id: 'premium' })).rejects.toThrow('Void the issued source-priced invoice');
    await expect(admin().write('Invoice', 'delete', { id: 'ia' })).rejects.toThrow('payment history');
  });
  it('allows the existing supplier-charge editor on a legacy bound policy without permitting markup or quote bypass', async () => {
    records['Policy:pa']={id:'pa',accountId:'a',premium:50000,billType:'AGENCY'};
    records['Invoice:ia']={id:'ia',accountId:'a',policyId:'pa',status:'DRAFT',sourcePricingVersion:1};
    const line={id:'manual-tax',invoiceId:'ia',accountId:'a',kind:'WHOLESALER_FEE',description:'RT brokerage fee',retailAmount:250,costAmount:250};
    await expect(user().write('InvoiceLine','create',line)).resolves.toBeUndefined();
    await expect(user().write('InvoiceLine','create',{...line,costAmount:0})).rejects.toThrow('without agency markup');
    records['Policy:pa'].passThroughCharges=[];
    await expect(user().write('InvoiceLine','create',line)).rejects.toThrow('reviewed source quote');
    await expect(admin().write('Policy','update',{id:'pa',passThroughCharges:null})).rejects.toThrow('immutable');
    records['Invoice:ia']={id:'ia',accountId:'a',quoteId:'qa',status:'DRAFT',sourcePricingVersion:1};
    records['Quote:qa']={id:'qa',accountId:'a',premium:50000};
    await expect(user().write('InvoiceLine','create',line)).rejects.toThrow('reviewed source quote');
  });
  it('requires actual paid initial-premium proof before creating an adjustment and retains immutable references',async()=>{
    process.env.ACCESS_TABLES=JSON.stringify({Invoice:'invoices',InvoiceLine:'lines'});
    records['Policy:pa']={id:'pa',accountId:'a',quoteId:'qa',premium:1000,billType:'AGENCY',status:'EXPIRED',updatedAt:'policy-version'};
    records['Invoice:original']={id:'original',accountId:'a',policyId:'pa',quoteId:'qa',status:'PAID',sourcePricingVersion:1,updatedAt:'invoice-version'};
    records['InvoiceLine:original-premium']={id:'original-premium',invoiceId:'original',accountId:'a',policyId:'pa',kind:'PREMIUM',retailAmount:1000,updatedAt:'line-version'};
    const next={id:'adjustment',accountId:'a',policyId:'pa',status:'DRAFT',sourcePricingVersion:2,adjustsInvoiceId:'original',adjustsPremiumLineId:'original-premium'};
    await expect(user().write('Invoice','create',next)).resolves.toBeUndefined();
    await expect(admin().write('Invoice','create',{id:'repeated',accountId:'a',policyId:'pa',status:'DRAFT',sourcePricingVersion:1})).rejects.toThrow('already has a paid original');
    await expect(admin().write('Invoice','create',{...next,adjustsPremiumLineId:'missing'})).rejects.toThrow('could not be verified');
    await expect(admin().write('Invoice','create',{...next,quoteId:'qa'})).rejects.toThrow('requires its policy');
    records['Invoice:adjustment']=next;
    await expect(admin().write('Invoice','update',{id:'adjustment',adjustsInvoiceId:null})).rejects.toThrow('cannot be changed');
    await expect(admin().write('Invoice','update',{id:'adjustment',sourcePricingVersion:1})).rejects.toThrow('cannot be changed');
    await expect(user().write('InvoiceLine','create',{id:'delta',invoiceId:'adjustment',accountId:'a',kind:'ENDORSEMENT',description:'Audit premium',retailAmount:null,costAmount:null})).resolves.toBeUndefined();
    await expect(user().write('InvoiceLine','create',{id:'wrong',invoiceId:'adjustment',accountId:'a',kind:'PREMIUM',retailAmount:1000,costAmount:900})).rejects.toThrow('Original premium');
    records['Invoice:adjustment']={...next,status:'SENT',stripePaymentLinkId:'live'};
    records['InvoiceLine:delta']={id:'delta',invoiceId:'adjustment',accountId:'a',kind:'ENDORSEMENT',retailAmount:100,costAmount:90};
    await expect(admin().write('InvoiceLine','delete',{id:'delta'})).rejects.toThrow('Void the issued');
    await expect(admin().write('Invoice','delete',{id:'original'})).rejects.toThrow('retain their source');
    await expect(admin().write('Invoice','update',{id:'original',policyId:'pb'})).rejects.toThrow('retain their source');
  });
  it.each(['DRAFT','SENT','PAID','PROCESSING'])('allows only the checked quote-to-policy provenance rollover on a %s fee invoice',async status=>{
    const policy={id:'pa',accountId:'a',quoteId:'qa',premium:1000,brokerFee:500,billType:'AGENCY',passThroughCharges:[]};
    records['Policy:pa']=policy;records['Quote:qa']={id:'qa',accountId:'a',premium:1000,brokerFee:500,billType:'AGENCY'};
    records['Invoice:quoted']={id:'quoted',accountId:'a',quoteId:'qa',status,sourcePricingVersion:1,stripePaymentLinkId:'original-link',brokerFeeAllocations:[{quoteId:'qa',amountCents:50000}]};
    records['InvoiceLine:quoted-premium']={id:'quoted-premium',invoiceId:'quoted',accountId:'a',kind:'PREMIUM',description:'Quoted premium',retailAmount:1000,costAmount:800};
    records['InvoiceLine:quoted-fee']={id:'quoted-fee',invoiceId:'quoted',accountId:'a',kind:'BROKER_FEE',brokerFeeQuoteId:'qa',retailAmount:500,costAmount:0};
    issuedFees.set('qa',{issuedInvoiceIds:['quoted']});
    await expect(user().write('Invoice','update',{id:'quoted',policyId:'pa'})).resolves.toBeUndefined();
    Object.assign(records['Invoice:quoted'],{policyId:'pa'});
    for(const id of ['quoted-premium','quoted-fee']) {
      await expect(user().write('InvoiceLine','update',{id,policyId:'pa'})).resolves.toBeUndefined();Object.assign(records[`InvoiceLine:${id}`],{policyId:'pa'});
      await expect(user().write('InvoiceLine','update',{id,policyId:'pa'})).resolves.toBeUndefined();
    }
    expect(()=>validateInvoiceSourceCharges({invoice:{accountId:'a',policyId:'pa',status,sourcePricingVersion:1},source:policy,lines:[records['InvoiceLine:quoted-premium'],records['InvoiceLine:quoted-fee']]})).not.toThrow();
    if(status==='DRAFT'||status==='SENT')expect(invoiceBrokerFeeAllocations({invoice:{accountId:'a',status,sourcePricingVersion:1},source:policy,quoteId:'qa',policyId:'pa',lines:[records['InvoiceLine:quoted-premium'],records['InvoiceLine:quoted-fee']],alreadySubmitted:false})).toEqual([{quoteId:'qa',policyId:'pa',amountCents:50000}]);
    await expect(admin().write('Invoice','update',{id:'quoted',policyId:'pb'})).rejects.toThrow();
    await expect(admin().write('InvoiceLine','update',{id:'quoted-premium',policyId:'pb'})).rejects.toThrow();
    await expect(admin().write('InvoiceLine','update',{id:'quoted-premium',policyId:'pa',retailAmount:1001})).rejects.toThrow();
  });
  it('does not allow rollover to a policy on another quote or combine the attachment with financial changes',async()=>{
    records['Invoice:quoted']={id:'quoted',accountId:'a',quoteId:'qa',status:'SENT',sourcePricingVersion:1,stripePaymentLinkId:'live'};
    records['Policy:pa']={id:'pa',accountId:'a',quoteId:'qb'};
    await expect(admin().write('Invoice','update',{id:'quoted',policyId:'pa'})).rejects.toThrow();
    records['Policy:pa'].quoteId='qa';
    await expect(admin().write('Invoice','update',{id:'quoted',policyId:'pa',status:'PAID'})).rejects.toThrow();
    await expect(admin().write('Invoice','update',{id:'quoted',policyId:'pa',quoteId:null})).rejects.toThrow();
  });
});
describe("files", () => {
  it("denies former managers copied document, generated, policy, certificate and photo URLs", async () => {
    for (const path of ["documents/ACCOUNT/a/da/file.pdf", "generated/a/form.pdf", "generated/pf/la/premium-finance-agreement.pdf", "certificates/a/cert.pdf", "property-photos/a/coverPhotoKey-cover.jpg"]) {
      await expect(user("manager").path(path, "read")).rejects.toThrow(AccessDenied);
      await expect(admin().path(path, "read")).resolves.toBeUndefined();
    }
  });
  it.each(["read", "write", "delete"] as const)("checks %s access to document, generated, certificate, and photo keys", async op => {
    for (const path of ["documents/ACCOUNT/b/db/file.pdf", "generated/b/form.pdf", "certificates/b/cert.pdf", "property-photos/b/cover.jpg"]) await expect(user().path(path, op)).rejects.toThrow(AccessDenied);
    for (const path of ["documents/ACCOUNT/a/da/file.pdf", "generated/a/form.pdf", "property-photos/a/coverPhotoKey-cover.jpg"]) await expect(user().path(path, op)).resolves.toBeUndefined();
  });
  it("binds certificate files to their record and preserves administrator-only deletion", async () => {
    for (const op of ["read", "write", "link"] as const) await expect(user().path("certificates/a/cert.pdf", op)).resolves.toBeUndefined();
    await expect(user().path("certificates/a/cert.pdf", "delete")).rejects.toThrow(AccessDenied);
    await expect(admin().path("certificates/a/cert.pdf", "delete")).resolves.toBeUndefined();
    await expect(user().path("certificates/a/unknown.pdf", "write")).rejects.toThrow(AccessDenied);
    records["Certificate:cert"].accountId = "b";
    await expect(user().path("certificates/a/cert.pdf", "write")).rejects.toThrow(AccessDenied);
    await expect(user().path("property-photos/a/arbitrary.pdf", "write")).rejects.toThrow(AccessDenied);
  });
  it("makes only the stored loan's exact generated agreement readable, never client-writable", async () => {
    const path = "generated/pf/la/premium-finance-agreement.pdf";
    await expect(user().path(path, "read")).resolves.toBeUndefined();
    await expect(user().path(path, "link", "a")).resolves.toBeUndefined();
    for (const actor of [user(), admin()]) for (const op of ["write", "delete"] as const) await expect(actor.path(path, op)).rejects.toThrow(AccessDenied);
    await expect(user().path("generated/pf/la/other.pdf", "read")).rejects.toThrow(AccessDenied);
    await expect(user().path(path, "link", "b")).rejects.toThrow(AccessDenied);
    await expect(user().path("generated/pf/lb/premium-finance-agreement.pdf", "read")).rejects.toThrow(AccessDenied);
  });
  it("permits linking pending uploads but blocks document IDs from other accounts", async () => {
    records["Document:da"].s3Key = "pending";
    await expect(user().write("Document", "update", { id: "da", s3Key: "documents/ACCOUNT/a/da/new.pdf" })).resolves.toBeUndefined();
    await expect(user().path("documents/ACCOUNT/a/db/file.pdf", "write")).rejects.toThrow(AccessDenied);
    await expect(user().path("documents/ACCOUNT/a/da/other.pdf", "read")).rejects.toThrow(AccessDenied);
  });
  it("checks long file keys instead of treating them as absent IDs", async () => {
    await expect(user().write("Document", "update", { id: "da", s3Key: `generated/b/${"x".repeat(510)}.pdf` })).rejects.toThrow(AccessDenied);
  });
  it("rejects path traversal and unknown prefixes", async () => {
    for (const path of ["documents/../b/file.pdf", "generated/a/../b/file.pdf", "generated/a//f.pdf", "private/a/file", "templates/../file", "generated\\a\\file"]) await expect(user().path(path, "read")).rejects.toThrow(AccessDenied);
  });
  it("keeps templates shared", async () => {
    await expect(user().path("templates/acord.pdf", "read")).resolves.toBeUndefined();
    await expect(user().path("templates/acord.pdf", "write")).rejects.toThrow(AccessDenied);
    await expect(admin().path("templates/acord.pdf", "write")).resolves.toBeUndefined();
  });
  it.each(["read", "write", "delete", "link"] as const)("requires the signature owner or administrator for %s", async operation => {
    await expect(user().path("signatures/alice-profile.png", operation)).resolves.toBeUndefined();
    await expect(user().path("signatures/bob-profile.png", operation)).rejects.toThrow(AccessDenied);
    await expect(user("manager").path("signatures/alice-profile.png", operation)).rejects.toThrow(AccessDenied);
    await expect(admin().path("signatures/bob-profile.png", operation)).resolves.toBeUndefined();
    await expect(admin().path("signatures/missing.png", operation)).rejects.toThrow(AccessDenied);
  });
});
describe("custom API operations", () => {
  const call = (op: string, input: RecordData = {}, actor = user()) => authorizeCustom(actor, "communicationWrite", { operation: op, input: JSON.stringify(input) });
  it('limits delivery context and history to the current account assignment and read operations', async () => {
    for (const readOperation of ['businessDeliveryContext', 'historyBusinessDeliveries']) {
      await expect(authorizeCustom(user(), 'communicationRead', { readOperation, input: { accountId: 'a' } })).resolves.toBeUndefined();
      await expect(authorizeCustom(user(), 'communicationRead', { readOperation, input: { accountId: 'b' } })).rejects.toThrow(AccessDenied);
      await expect(call(readOperation, { accountId: 'a' })).rejects.toThrow(AccessDenied);
    }
  });
  it('checks every package quote and selected attachment before creating a delivery preview', async () => {
    records['Communication:commercial:a'] = { data: { options: [{ id: 'option', quoteIds: ['qa'] }] } };
    const input = { accountId: 'a', kind: 'PACKAGE', recordId: 'option', conversationId: 'NEW', documentIds: ['da'] };
    await expect(call('previewBusinessDelivery', input)).resolves.toBeUndefined();
    await expect(call('previewBusinessDelivery', { ...input, documentIds: ['db'] })).rejects.toThrow(AccessDenied);
    await expect(call('previewBusinessDelivery', { ...input, conversationId: 'cnv_b' })).rejects.toThrow(AccessDenied);
    records['Communication:commercial:a'].data = { options: [{ id: 'option', quoteIds: ['qb'] }] };
    await expect(call('previewBusinessDelivery', input)).rejects.toThrow(AccessDenied);
  });
  it('uses server-owned preview and attempt actor/account bindings for preparation and private reconciliation', async () => {
    records['Communication:preview'] = { kind: 'BUSINESS_PREVIEW', accountId: 'a', data: { actor: 'alice', preview: { selection: { accountId: 'a' } } } };
    records['Communication:attempt'] = { kind: 'BUSINESS_DELIVERY', accountId: 'a', data: { actor: 'alice', accountId: 'a' } };
    await expect(call('prepareBusinessDraft', { accountId: 'a', previewId: 'preview', conversationId: 'NEW' })).resolves.toBeUndefined();
    await expect(call('reconcileBusinessDraft', { accountId: 'a', attemptId: 'attempt' })).resolves.toBeUndefined();
    records['Communication:preview'].data = { actor: 'bob', preview: { selection: { accountId: 'a' } } };
    await expect(call('prepareBusinessDraft', { accountId: 'a', previewId: 'preview' })).rejects.toThrow(AccessDenied);
    records['Communication:attempt'].data = { actor: 'bob', accountId: 'a' };
    await expect(call('reconcileBusinessDraft', { accountId: 'a', attemptId: 'attempt' })).rejects.toThrow(AccessDenied);
    await expect(call('prepareBusinessDraft', { accountId: 'a', previewId: 'task:a' })).rejects.toThrow(AccessDenied);
  });
  it('limits follow-up changes to the current salesperson or an active administrator', async () => {
    const input = { accountId: 'a', version: 0, followUpOn: '2026-10-10', note: '' };
    await expect(call('saveLeadSnooze', input)).resolves.toBeUndefined();
    await expect(call('saveLeadSnooze', { ...input, accountId: 'b' })).rejects.toThrow(AccessDenied);
    await expect(call('saveLeadSnooze', input, user('manager'))).rejects.toThrow(AccessDenied);
    await expect(call('saveLeadSnooze', input, admin())).resolves.toBeUndefined();
    const narrowedAdmin = new AccountAccess({ sub: 'admin', groups: ['ADMIN', 'PRODUCER'] }, reader, { headers: { 'x-crm-role': 'PRODUCER' } });
    await expect(call('saveLeadSnooze', input, narrowedAdmin)).rejects.toThrow(AccessDenied);
    records['Communication:workflow:a'].data = { salespersonId: 'bob' };
    await expect(call('saveLeadSnooze', input)).rejects.toThrow(AccessDenied);
    await expect(call('saveLeadSnooze', input, user('bob'))).resolves.toBeUndefined();
    records['Communication:deleted-account:a'] = { id: 'deleted-account:a' };
    await expect(call('saveLeadSnooze', input, user('bob'))).rejects.toThrow(AccessDenied);
  });
  it("requires an administrator for all salesperson assignment writes", async () => {
    await expect(call("setResponsibilities", { accountId: "b", salespersonId: "alice" })).rejects.toThrow(AccessDenied);
    await expect(call("setResponsibilities", { accountId: "a", salespersonId: "bob" })).rejects.toThrow(AccessDenied);
    await expect(call("setResponsibilities", { accountId: "a", salespersonId: "alice" })).rejects.toThrow(AccessDenied);
    const identity = { sub: "alice", groups: ["ADMIN", "PRODUCER"] };
    const input = { accountId: "a", salespersonId: "alice" };
    await expect(call("setResponsibilities", input, new AccountAccess(identity, reader, { headers: { "x-crm-role": "PRODUCER" } }))).rejects.toThrow(AccessDenied);
    await expect(call("setResponsibilities", input, new AccountAccess(identity, reader, { headers: { "x-crm-role": "ADMIN" } }))).resolves.toBeUndefined();
  });
  it("allows only active administrators to reassign a client to another salesperson", async () => {
    records["Account:a"].stage = "CLIENT";
    records["Communication:workflow:a"].data = { salespersonId: "alice", disposition: "BOUND" };
    const input = { accountId: "a", salespersonId: "bob", version: 1 };
    await expect(call("setResponsibilities", input)).rejects.toThrow(AccessDenied);
    await expect(call("setResponsibilities", input, user("bob"))).rejects.toThrow(AccessDenied);
    await expect(call("setResponsibilities", input, admin())).resolves.toBeUndefined();
    const narrowedAdmin = new AccountAccess({ sub: "alice", groups: ["ADMIN", "PRODUCER"] }, reader, { headers: { "x-crm-role": "PRODUCER" } });
    await expect(call("setResponsibilities", input, narrowedAdmin)).rejects.toThrow(AccessDenied);
  });
  it("allows only administrators to create or reassign leads for another salesperson", async () => {
    await expect(call("createLead", { salespersonId: "alice" }, user("manager"))).rejects.toThrow(AccessDenied);
    await expect(call("createLead", { salespersonId: "bob" }, user("manager"))).rejects.toThrow(AccessDenied);
    await expect(call("createLead")).resolves.toBeUndefined();
    await expect(call("createLead", {}, user("manager"))).resolves.toBeUndefined();
    records["Communication:workflow:owned"] = { data: { salespersonId: "manager" } };
    await expect(call("setResponsibilities", { accountId: "owned", salespersonId: "alice" }, user("manager"))).rejects.toThrow(AccessDenied);
    await expect(call("setResponsibilities", { accountId: "a", salespersonId: "manager" }, user("manager"))).rejects.toThrow(AccessDenied);
    await expect(call("setResponsibilities", { accountId: "owned", salespersonId: "manager" }, user("manager"))).rejects.toThrow(AccessDenied);
    await expect(call("createLead", { salespersonId: "alice" }, admin())).resolves.toBeUndefined();
    await expect(call("setResponsibilities", { accountId: "owned", salespersonId: "alice" }, admin())).resolves.toBeUndefined();
  });
  it("denies former managers account, billing and conversation operations for prior reports", async () => {
    for (const [field, args] of [
      ["startLeadExtraction", { accountId: "a" }],
      ["sendInvoice", { invoiceId: "ia" }],
      ["servicePfLoan", { loanId: "la" }],
      ["communicationRead", { readOperation: "context", input: { accountId: "a" } }],
      ["communicationRead", { readOperation: "context", input: { conversationId: "cnv_a" } }],
    ] as const) {
      await expect(authorizeCustom(user("manager"), field, args)).rejects.toThrow(AccessDenied);
      await expect(authorizeCustom(admin(), field, args)).resolves.toBeUndefined();
    }
  });
  it("gates carrier, extraction and billing endpoints by account or stored parent", async () => {
    for (const field of ["startLeadExtraction", "suggestFormFields", "startHoneycombSubmission"]) {
      await expect(authorizeCustom(user(), field, { accountId: "b" })).rejects.toThrow(AccessDenied);
      await expect(authorizeCustom(user(), field, { accountId: "a" })).resolves.toBeUndefined();
    }
    await expect(authorizeCustom(user(), "startHoneycombSubmission", { accountId: "a", sourceEstimateId: "eb" })).rejects.toThrow(AccessDenied);
    await expect(authorizeCustom(user(), "sendInvoice", { invoiceId: "ib" })).rejects.toThrow(AccessDenied);
    await expect(authorizeCustom(user(), "servicePfLoan", { loanId: "la", policyId: "pb" })).rejects.toThrow(AccessDenied);
  });
  it("checks communication/task IDs and a conflicting account cannot override them", async () => {
    await expect(call("updateBlocker", { taskId: "task:b", accountId: "a" })).rejects.toThrow(AccessDenied);
    await expect(call("context", { conversationId: "cnv_b", accountId: "a" })).rejects.toThrow(AccessDenied);
    await expect(call("context", { conversationId: "unlinked" })).rejects.toThrow(AccessDenied);
    await expect(call("recordCallOutcome", { id: "task:a", taskId: "task:b" })).rejects.toThrow(AccessDenied);
    await expect(call("mergeTasks", { accountId: "a", tasks: [{ id: "task:b" }] })).rejects.toThrow(AccessDenied);
  });
  it("retires delegation for every account", async () => {
    await expect(call("delegateService", { taskId: "task:a", specialistId: "bob" })).rejects.toThrow(AccessDenied);
    await expect(call("delegateService", { taskId: "task:a", specialistId: "manager" })).rejects.toThrow(AccessDenied);
    await expect(call("delegateService", { taskId: "task:a", specialistId: "alice" })).rejects.toThrow(AccessDenied);
  });
  it("does not grant account, blocker or report access through a legacy specialist assignment", async () => {
    records["Communication:task:a"].data = { accountId: "a", specialistId: "bob", blocker: { ownerId: "bob" } };
    const specialist = user("bob");
    expect(await specialist.canAccount("a")).toBe(false);
    await expect(authorizeCustom(specialist, "communicationWrite", { operation: "updateBlocker", input: { taskId: "task:a" } })).rejects.toThrow(AccessDenied);
    const notice = { id: "notice:task:a:bob", accountId: "a", recipient: "bob" };
    await expect(filterCustom(specialist, "communicationRead", { readOperation: "work", input: { kind: "NOTIFICATION" } }, { items: [notice] })).rejects.toThrow(AccessDenied);
    await expect(filterCustom(specialist, "communicationRead", { readOperation: "myReport" }, { report: { items: [{ id: "task:a", accountId: "a", stage: "DUE", role: "Specialist" }] } })).rejects.toThrow(AccessDenied);
  });
  it("rejects administrative and unknown operations", async () => {
    for (const op of ["settings", "saveTeamRouting", "saveEligibility", "backfill", "unknown"]) await expect(call(op)).rejects.toThrow(AccessDenied);
    await expect(call("takeResponse", { taskId: "task:a", accountId: "a" })).rejects.toThrow(AccessDenied);
    await expect(authorizeCustom(user(), "futureEndpoint", {})).rejects.toThrow(AccessDenied);
  });
  it("keeps saved Team settings restricted to the active administrator or Owner view", async () => {
    const args = { readOperation: "teamSettings", input: { userIds: ["alice"] } };
    for (const actor of [user(), new AccountAccess({ sub: "admin", groups: ["ADMIN", "PRODUCER"] }, reader, { headers: { "x-crm-role": "PRODUCER" } })]) {
      await expect(authorizeCustom(actor, "communicationRead", args)).rejects.toThrow(AccessDenied);
    }
    for (const actor of [admin(), new AccountAccess({ sub: "owner", groups: ["OWNER"] }, reader)]) {
      await expect(authorizeCustom(actor, "communicationRead", args)).resolves.toBeUndefined();
    }
  });
  it("filters work pages and preserves cursors even when a page is empty", async () => {
    const result = await filterCustom(user(), "communicationRead", { readOperation: "work", input: { kind: "WORKFLOW" } }, { ok: true, items: [{ id: "b", accountId: "b" }, { id: "unlinked" }], nextToken: "cursor" });
    expect(result).toEqual({ ok: true, items: [], nextToken: "cursor" });
  });
  it("limits assignment choices", async () => {
    const team = await filterCustom(user(), "communicationRead", { readOperation: "context" }, { team: [{ userId: "alice", salesperson: true }, { userId: "bob", salesperson: true }] });
    expect(team).toMatchObject({ actorId: "alice", team: [{ userId: "alice", salesperson: true }, { userId: "bob", salesperson: false }] });
  });
  it("limits former managers' team assignment choices and account visibility to themselves", async () => {
    records["Communication:workflow:owned"] = { data: { salespersonId: "manager" } };
    const result = await filterCustom(user("manager"), "communicationRead", { readOperation: "context" }, {
      workflow: { accountId: "owned" }, team: [{ userId: "manager", salesperson: true }, { userId: "alice", salesperson: true }],
    });
    expect(result).toMatchObject({ actorId: "manager", team: [{ userId: "manager", salesperson: true, canAccessAccount: true }, { userId: "alice", salesperson: false, canAccessAccount: false }] });
  });
});


describe("retired tasks and daily staff reports", () => {
  it("denies historical task model reads and writes to staff and administrators", async () => {
    for (const actor of [user(), admin()]) {
      expect(await actor.canRecord("MarketingTask", { id: "task", accountId: "a" })).toBe(false);
      for (const operation of ["create", "update", "delete"]) await expect(actor.write("MarketingTask", operation, { id: "task", accountId: "a" })).rejects.toThrow(AccessDenied);
    }
  });
  it("rejects cached task and daily-report requests before any data access for every role", async () => {
    const { RETIRED_TASK_OPERATIONS } = await import("../../../shared/retiredTaskOperations");
    for (const groups of [[], ["ADMIN"]]) {
      const actor = new AccountAccess({ sub: "alice", groups }, async () => { throw new Error("Unexpected data read"); });
      for (const operation of RETIRED_TASK_OPERATIONS) {
        await expect(authorizeCustom(actor, "communicationWrite", { operation, input: '{}' })).rejects.toThrow(AccessDenied);
        await expect(authorizeCustom(actor, "communicationRead", { readOperation: operation })).rejects.toThrow(AccessDenied);
        await expect(filterCustom(actor, "communicationRead", { readOperation: operation }, { report: { items: [{ accountId: "a" }] } })).rejects.toThrow(AccessDenied);
      }
      for (const kind of [undefined, null, "", " ", " TASK ", "TASK", "NOTIFICATION"]) {
        await expect(authorizeCustom(actor, "communicationRead", { readOperation: "work", input: { kind } })).rejects.toThrow(AccessDenied);
        await expect(filterCustom(actor, "communicationRead", { readOperation: "work", input: { kind } }, { items: [] })).rejects.toThrow(AccessDenied);
      }
      await expect(authorizeCustom(actor, "communicationWrite", { operation: "recordCallOutcome", input: { id: "call", taskId: "task" } })).rejects.toThrow(AccessDenied);
    }
  });
});

describe('relationship access boundaries', () => {
  it('shares directory identities while keeping reverse portfolio links scoped', async () => {
    expect(await user().canRecord('Party', { id: 'manager' })).toBe(true);
    expect(await user().canRecord('PartyAffiliation', { personId: 'p', organizationId: 'manager' })).toBe(true);
    expect(await user().canRecord('AccountRelationship', { id: 'link-a', accountId: 'a', partyId: 'manager' })).toBe(true);
    expect(await user().canRecord('AccountRelationship', { id: 'link-b', accountId: 'b', partyId: 'manager' })).toBe(false);
    await expect(authorizeCustom(user(), 'communicationWrite', { operation: 'relationshipChangeManagement', input: { accountId: 'b' } })).rejects.toThrow(AccessDenied);
  });
  it('prevents generic writes from rewriting relationship dates or deleting historical contacts', async () => {
    records['Contact:managed'] = { id: 'managed', accountId: 'a', relationshipId: 'r', validFrom: '2020-01-01', validUntil: '2021-01-01' };
    for (const access of [user(), admin()]) {
      await expect(access.write('Contact', 'update', { id: 'managed', validUntil: null })).rejects.toThrow(AccessDenied);
      await expect(access.write('Contact', 'update', { id: 'managed', name: 'Rewrite history' })).rejects.toThrow(AccessDenied);
      await expect(access.write('Contact', 'delete', { id: 'managed' })).rejects.toThrow(AccessDenied);
      await expect(access.write('Contact', 'create', { accountId: 'a', name: 'Bypass', relationshipId: 'r' })).rejects.toThrow(AccessDenied);
    }
    records['Communication:deleted-account:a'] = { id: 'deleted-account:a' };
    await expect(admin().write('Contact', 'delete', { id: 'managed' })).resolves.toBeUndefined();
  });
});
