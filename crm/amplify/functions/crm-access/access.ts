import { assertBrokerFeeAgencyBilling, brokerFeeCents, feeAllocations } from '../../../../shared/brokerFees';
import { quoteSourceBillingHistory } from '../quote-source-billing';
import { assertNoFeeLoanCheckout } from '../broker-fees/payments';
import { getFee, getAgreement, getModel } from '../broker-fees/store';
import { authorizedQuoteTerms } from '../../../../shared/quoteAuthorization';
import { normalizeClientConditions, normalizePassThroughCharges } from '../../../../shared/passThroughCharges';
import { validateInvoiceSourceCharges } from '../send-invoice/passThroughInvoice';
import { GROUPED_INVOICE_REVIEW_ONLY, isGroupedInvoice } from '../../../../shared/groupedInvoiceGuard';
import { assertAdjustmentInvoiceProof, assertInitialInvoiceAvailable } from '../send-invoice/adjustmentInvoice';
import { relationshipCurrent } from "../../../../shared/relationships";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { batchGetComplete } from '../storage/batchGet';
import { modelKeyName, resolveModelTable, storedModel } from '../storage/models';
import { ACCOUNT_MODELS, ACCOUNT_REFERENCES, LIST_PARENTS, SHARED_MODELS, RETIRED_MODELS, AccessDenied, id, type Identity, type RecordData } from "./policy";
import { object } from '../api-input';
import { isActiveAdmin, type RoleRequest } from "./active-role";
export const db = DynamoDBDocumentClient.from(new DynamoDBClient());
export function tableName(model: string) {
  const error = () => new Error('Account access is not configured');
  return resolveModelTable(storedModel(model, error), { error });
}
const primaryKey = (model: string) => modelKeyName(storedModel(model, () => new Error('Account access is not configured')));
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
  private async issuedBrokerFeeInvoice(invoice: RecordData) {
    if(feeAllocations(invoice.brokerFeeAllocations).length>0||Number(invoice.remittanceBrokerFeeCents??0)>0)return true;
    const policy=invoice.policyId?await this.get("Policy",id(invoice.policyId)):undefined;
    const quoteId=id(policy?.quoteId)||id(invoice.quoteId);
    return !!quoteId&&!!(await getFee(quoteId))?.issuedInvoiceIds?.includes(id(invoice.id));
  }
  private async quotePolicyAttachment(invoice:RecordData|undefined,policyId:string) {
    if(!invoice||!id(invoice.quoteId)||!policyId||invoice.policyId&&invoice.policyId!==policyId)return false;
    const policy=await this.get("Policy",policyId);
    return !!policy&&policy.accountId===invoice.accountId&&policy.quoteId===invoice.quoteId;
  }
  async prefetch(model: string, keys: string[]) {
    const missing = [...new Set(keys)].filter(key => key && !this.records.has(`${model}:${key}`));
    if (!missing.length) return;
    if (this.reader !== read) { await Promise.all(missing.map(key => this.get(model, key))); return; }
    const name = tableName(model), keyField = primaryKey(model);
    const rows = await batchGetComplete<RecordData>({ send: command => db.send(command), table: name,
      keys: missing.map(key => ({ [keyField]: key })), maxKeys: Number.MAX_SAFE_INTEGER, attempts: 4,
      read: { ConsistentRead: true }, sizeError: () => new Error('Account access lookup is busy; please retry'),
      incompleteError: () => new Error('Account access lookup is busy; please retry') });
    const found = new Map(rows.map(item => [id(item[keyField]), item]));
    for (const key of missing) this.records.set(`${model}:${key}`, Promise.resolve(found.get(key)));
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
    if (model === "Contact") {
      if (["partyId", "relationshipId", "validFrom", "validUntil", "isBilling"].some(field => Object.hasOwn(input, field))) throw new AccessDenied();
      const existing = input.id ? await this.get("Contact", id(input.id)) : undefined;
      if (existing?.relationshipId && input.accountId != null && input.accountId !== existing.accountId) throw new AccessDenied();
      if (existing && ((!relationshipCurrent(existing) && operation === "update") || (existing.relationshipId || existing.validUntil) && operation === "delete") && !(operation === "delete" && this.admin && await this.get("Communication", `deleted-account:${id(existing.accountId)}`))) throw new AccessDenied();
    }
    if(!this.admin&&operation!=="create"&&["Quote","Policy","Invoice","InvoiceLine","Document","AgencySettings"].includes(model)) {
      const existing=await this.get(model,id(input.id));
      if(!existing||!await this.canRecord(model,existing))throw new AccessDenied();
    }
    if(model==="Account"&&Object.hasOwn(input,"brokerFeeHistory"))throw new Error("Signed disclosure retention history is server-owned.");
    if(model==="Account"&&operation==="delete"&&(await this.get("Account",id(input.id)))?.brokerFeeHistory)throw new Error("Accounts with signed fee disclosures must retain their document history.");
    if (model === "Document") {
      const previous = input.id ? await this.get("Document", id(input.id)) : undefined;
      if (operation === "create" && input.uploadedName != null && input.uploadedName !== input.name) throw new Error("The uploaded filename must match the initial document name.");
      if (operation === "update" && Object.hasOwn(input, "uploadedName") && (input.uploadedName ?? null) !== (previous?.uploadedName ?? null)) throw new Error("The original uploaded filename cannot be changed.");
      if (input.category === "BROKER_FEE_DISCLOSURE" || previous?.category === "BROKER_FEE_DISCLOSURE") throw new Error("Signed broker fee disclosures are preserved by the signing service and cannot be replaced or deleted.");
    }
    if (model === "AgencySettings" && ["brokerFeeJurisdictions","brokerFeeJurisdictionsVersion"].some(key=>Object.hasOwn(input,key))) throw new Error("Save reviewed broker fee rules through Agency settings.");
    if (model === "Quote" && operation === "delete") {
      const fee=await getFee(id(input.id));
      if(fee&&(fee.signedAt||fee.submittedCents>0||fee.collectedCents>0||fee.policyId))throw new Error("Quotes with signed fee or payment history cannot be deleted. Preserve the record and its adjustments.");
    }
    if (model === "Quote" && ["create","update"].includes(operation)) {
      if(Object.hasOwn(input,"passThroughCharges"))normalizePassThroughCharges(input.passThroughCharges);
      if(Object.hasOwn(input,"clientConditions"))normalizeClientConditions(input.clientConditions);
      if (Object.hasOwn(input,"brokerFee")) brokerFeeCents(input.brokerFee as number|null);
      const previous = input.id ? await this.get("Quote",id(input.id)) : undefined;
      assertBrokerFeeAgencyBilling({...previous,...input} as {brokerFee?:number|null;billType?:string|null});
      if(previous&&Object.hasOwn(input,"accountId")&&input.accountId!==previous.accountId) {
        const feeHistory=await getFee(id(previous.id));
        if(brokerFeeCents(previous.brokerFee as number|undefined)>0||brokerFeeCents(input.brokerFee as number|undefined)>0||feeHistory)throw new Error("A quote with fee history must retain its original account.");
        const billing=await quoteSourceBillingHistory(previous,undefined);
        if(billing.invoices.length||billing.loans.length)throw new Error("A quote with billing history must retain its original account.");
      }
      if(previous?.status==="BOUND"&&((Object.hasOwn(input,"passThroughCharges")&&JSON.stringify(normalizePassThroughCharges(input.passThroughCharges))!==JSON.stringify(normalizePassThroughCharges(previous.passThroughCharges)))||(Object.hasOwn(input,"clientConditions")&&normalizeClientConditions(input.clientConditions)!==normalizeClientConditions(previous.clientConditions))))throw new Error("Bound policy charges and client conditions cannot be changed.");
      if (previous && (brokerFeeCents(previous.brokerFee as number|undefined)>0 || brokerFeeCents(input.brokerFee as number|undefined)>0)) {
        const fee = await getFee(String(previous.id));
        const agreement=fee?.agreementId?await getAgreement(fee.agreementId):undefined;
        const disclosed=agreement?.quotes.find(q=>q.id===previous.id)?.agencyCommissionPct!==undefined;
        const changed=authorizedQuoteTerms(previous)!==authorizedQuoteTerms({...previous,...input}) || disclosed&&Object.hasOwn(input,"commissionPct")&&input.commissionPct!==previous.commissionPct;
        if(changed&&previous.status==="BOUND")throw new Error("Bound policy fee terms cannot be changed.");
        if(changed&&fee&&(fee.submittedCents>0||fee.collectedCents>0)&&(authorizedQuoteTerms({...previous,...input})!==fee.terms||disclosed&&({...previous,...input}).commissionPct!==agreement?.quotes.find(q=>q.id===previous.id)?.agencyCommissionPct))throw new Error("This fee already has a payment. Review the existing payment before changing the accepted terms.");
        if(fee&&(changed||["LOST","DECLINED"].includes(String(input.status))))await assertNoFeeLoanCheckout(fee);
        if(fee&&(changed||["LOST","DECLINED"].includes(String(input.status))))for(const invoiceId of fee.issuedInvoiceIds??[]) {
          const invoice=await getModel<Record<string,unknown>>("Invoice",invoiceId);
          if(invoice&&["DRAFT","SENT","PROCESSING"].includes(String(invoice.status)))throw new Error("Void the existing fee invoice before changing or withdrawing its accepted quote terms.");
        }
      }
    }
    if (model === "Invoice") {
      const previous = input.id ? await this.get("Invoice",id(input.id)) : undefined;
      if (isGroupedInvoice(previous ?? {}) || previous?.supersededByGroupedInvoiceId || Object.hasOwn(input, 'groupedPolicyIds') || input.sourcePricingVersion === 3) throw new Error(GROUPED_INVOICE_REVIEW_ONLY);
      if(operation==="create") {
        if(![1,2].includes(input.sourcePricingVersion as number)||input.status!=="DRAFT"||!input.quoteId&&!input.policyId)throw new Error("Create a source-priced draft invoice from its quote or policy.");
        if (input.policyId) {
          const policy = await this.get('Policy', id(input.policyId));
          if (policy?.carrierBillType === 'DIRECT' && policy.billType === 'AGENCY') throw new Error('This carrier premium must use the grouped review workflow.');
          if (id(policy?.groupedDraftInvoiceId) && (await this.get('Invoice', id(policy?.groupedDraftInvoiceId)))?.status !== 'VOID') throw new Error('This policy already belongs to a grouped invoice.');
        }
        if(input.sourcePricingVersion===2)await assertAdjustmentInvoiceProof(input,(model,key)=>this.get(model,key));
        else {
          if(input.adjustsInvoiceId||input.adjustsPremiumLineId)throw new Error("Only a proven policy adjustment may reference a paid original invoice.");
          await assertInitialInvoiceAvailable(input,{reader:(model,key)=>this.get(model,key)});
        }
      }
      if(previous&&Object.hasOwn(input,"sourcePricingVersion")&&(input.sourcePricingVersion??null)!==(previous.sourcePricingVersion??null))throw new Error("Invoice source pricing provenance cannot be changed or removed.");
      if(previous&&["adjustsInvoiceId","adjustsPremiumLineId"].some(field=>Object.hasOwn(input,field)&&(input[field]??null)!==(previous[field]??null)))throw new Error("The paid original invoice adjustment references cannot be changed or removed.");
      const changesIssuedIdentity=previous&&["accountId","quoteId","policyId"].some(field=>Object.hasOwn(input,field)&&(input[field]??null)!==(previous[field]??null));
      const changesStatus=previous&&Object.hasOwn(input,"status")&&input.status!==previous.status;
      const rollover=operation==="update"&&previous&&!previous.policyId&&Object.keys(input).every(field=>["id","policyId","lastWriteBy"].includes(field))&&await this.quotePolicyAttachment(previous,id(input.policyId));
      if(previous&&["PAID","PROCESSING"].includes(String(previous.status))&&(operation==="delete"||changesIssuedIdentity&&!rollover))throw new Error("Paid or clearing invoices retain their source and payment history and cannot be deleted or moved.");
      if([1,2].includes(Number(previous?.sourcePricingVersion))&&(changesIssuedIdentity&&!rollover||changesStatus||operation==="delete"&&(previous?.status!=="DRAFT"||previous?.stripePaymentLinkId)))throw new Error("Source-priced invoices retain their source and payment history. Use the invoice payment or void action.");
      if(previous&&(operation==="delete"||changesStatus||changesIssuedIdentity&&!rollover)) {
        if(await this.issuedBrokerFeeInvoice(previous))throw new Error("Issued broker fee invoices retain their source and payment history. Use the invoice payment or void action to change their status.");
      }
      if(["create","update"].includes(operation)) {
        if (previous&&["PAID","PROCESSING"].includes(String(previous.status))&&Object.hasOwn(input,"status")&&input.status!==previous.status) throw new Error("Submitted payment status is controlled by payment reconciliation.");
        if ((["PAID","PROCESSING"].includes(String(input.status)) && input.status!==previous?.status) || Object.hasOwn(input,"paidAt") && input.paidAt!==previous?.paidAt) throw new Error("Record payment through the invoice payment action.");
        if (["paymentUrl","stripePaymentLinkId","stripeLinkAmountCents","stripePaymentIntentId","stripeEventAt","stripeIntentCreatedAt","remittanceCarrierCents","remittanceCommissionCents","remittanceInterestCents","remittanceBrokerFeeCents","brokerFeeAllocations","brokerFeeFinanceUrl"].some(key=>Object.hasOwn(input,key) && JSON.stringify(input[key]??null)!==JSON.stringify(previous?.[key]??null))) throw new Error("Issued fee payment allocations are server-owned.");
      }
    }
    if (model === "InvoiceLine") {
      const previous = input.id ? await this.get("InvoiceLine",id(input.id)) : undefined;
      const candidate = {...previous,...input};
      const invoice = await this.get("Invoice",id(candidate.invoiceId));
      const previousInvoice=previous?.invoiceId&&previous.invoiceId!==candidate.invoiceId?await this.get("Invoice",id(previous.invoiceId)):undefined;
      const rollover=operation==="update"&&previous&&(!previous.policyId||previous.policyId===input.policyId)&&Object.keys(input).every(field=>["id","policyId","lastWriteBy","updatedBy"].includes(field))&&await this.quotePolicyAttachment(invoice,id(input.policyId));
      for(const parent of [invoice,previousInvoice])if(parent) {
        if (isGroupedInvoice(parent) || parent.supersededByGroupedInvoiceId) throw new Error(GROUPED_INVOICE_REVIEW_ONLY);
        if(rollover)continue;
        if (["PAID","PROCESSING"].includes(String(parent.status))) throw new Error("Payment allocation lines cannot change after payment is submitted.");
        if([1,2].includes(Number(parent.sourcePricingVersion))&&(parent.status==="SENT"||parent.stripePaymentLinkId))throw new Error("Void the issued source-priced invoice before changing its payment lines.");
        if(["DRAFT","SENT"].includes(String(parent.status))&&await this.issuedBrokerFeeInvoice(parent))throw new Error("Void the issued fee invoice before changing its payment lines.");
        if(parent.status==="SENT") {
          const policy=parent.policyId?await this.get("Policy",id(parent.policyId)):undefined;
          const source=policy??(parent.quoteId?await this.get("Quote",id(parent.quoteId)):undefined);
          if(candidate.sourceQuoteChargeId||previous?.sourceQuoteChargeId||normalizePassThroughCharges(source?.passThroughCharges).length)throw new Error("Void the issued invoice before changing its source charge payment lines.");
        }
      }
      if(previous?.sourceQuoteChargeId&&operation==="delete") {
        const policy=invoice?.policyId?await this.get("Policy",id(invoice.policyId)):undefined;
        const source=policy??(invoice?.quoteId?await this.get("Quote",id(invoice.quoteId)):undefined);
        if(invoice?.status!=="DRAFT"||!source||normalizePassThroughCharges(source.passThroughCharges).some(charge=>charge.id===previous.sourceQuoteChargeId))throw new Error("Pass-through invoice charges come from the source quote. Only an obsolete unissued draft charge can be removed.");
      }
      if(previous?.sourceQuoteChargeId&&["sourceQuoteChargeId","invoiceId"].some(field=>Object.hasOwn(input,field)&&input[field]!==previous[field]))throw new Error("A generated pass-through charge cannot be detached from its source invoice.");
      if(!rollover&&operation!=="delete"&&(candidate.sourceQuoteChargeId||["CARRIER_FEE","WHOLESALER_FEE","TAX","SURPLUS_LINES","STAMPING_FEE"].includes(String(candidate.kind)))) {
        const policy=invoice?.policyId?await this.get("Policy",id(invoice.policyId)):undefined;
        const source=policy??(invoice?.quoteId?await this.get("Quote",id(invoice.quoteId)):undefined);
        validateInvoiceSourceCharges({invoice:{accountId:id(invoice?.accountId),policyId:id(invoice?.policyId),status:invoice?.status as string|undefined,sourcePricingVersion:invoice?.sourcePricingVersion as number|undefined},source:source?{id:id(source.id),accountId:id(source.accountId),premium:source.premium as number|undefined,billType:source.billType as string|undefined,passThroughCharges:source.passThroughCharges}:null,lines:[candidate],requireAll:false});
      }
      if(!rollover&&invoice&&[1,2].includes(Number(invoice.sourcePricingVersion))&&operation!=="delete"&&!candidate.sourceQuoteChargeId) {
        const policy=invoice.policyId?await this.get("Policy",id(invoice.policyId)):undefined;
        const source=policy??(invoice.quoteId?await this.get("Quote",id(invoice.quoteId)):undefined);
        validateInvoiceSourceCharges({invoice:{accountId:id(invoice?.accountId),policyId:id(invoice?.policyId),status:invoice?.status as string|undefined,sourcePricingVersion:invoice?.sourcePricingVersion as number},source:source?{id:id(source.id),accountId:id(source.accountId),premium:source.premium as number|undefined,billType:source.billType as string|undefined,passThroughCharges:source.passThroughCharges}:null,lines:[candidate],requireAll:false});
      }
      if (!rollover&&candidate.kind === "BROKER_FEE" && operation!=="delete") {
        const quote = await this.get("Quote",id(candidate.brokerFeeQuoteId));
        if (!quote || quote.accountId!==invoice?.accountId || Number(candidate.costAmount??0)!==0 || brokerFeeCents(candidate.retailAmount as number)!==brokerFeeCents(quote.brokerFee as number|undefined)) throw new Error("The broker fee line must match its accepted quote and have no carrier cost.");
      }
    }
    // Financial provenance is server-owned, including in the Owner view.
    if (model === "Policy" && operation === "create") throw new Error("Bind the quote through the commission-aware bind workflow.");
    if (model === "Quote" && input.status === "BOUND" && (operation === "create" || (await this.get("Quote", id(input.id)))?.status !== "BOUND")) throw new Error("Use the bind workflow to mark a quote bound.");
    if (model === "Policy" && operation === "update") {
      const prior = await this.get("Policy", id(input.id));
      if (['carrierBillType', 'groupedDraftInvoiceId'].some(field => Object.hasOwn(input, field) && (input[field] ?? null) !== (prior?.[field] ?? null))) throw new Error('Carrier billing and grouped invoice provenance are server-owned.');
      if (prior?.carrierBillType && Object.hasOwn(input, 'billType') && input.billType !== prior.billType) throw new Error('Preserve the reviewed carrier billing and HOA collection arrangement.');
      assertBrokerFeeAgencyBilling({...prior,...input} as {brokerFee?:number|null;billType?:string|null});
      if(Object.hasOwn(input,"passThroughCharges")&&((input.passThroughCharges!=null)!==(prior?.passThroughCharges!=null)||JSON.stringify(normalizePassThroughCharges(input.passThroughCharges))!==JSON.stringify(normalizePassThroughCharges(prior?.passThroughCharges)))||Object.hasOwn(input,"clientConditions")&&normalizeClientConditions(input.clientConditions)!==normalizeClientConditions(prior?.clientConditions))throw new Error("Bound policy charges and client conditions are immutable. Record a reviewed adjustment instead.");
      if (Object.hasOwn(input, "commissionSnapshotId") && input.commissionSnapshotId !== prior?.commissionSnapshotId) throw new Error("Commission provenance is server-owned.");
      if (prior && ["brokerFee", "accountId", "quoteId", "carrierId", "premium", "commissionPct", "effectiveDate", "expirationDate", "datePolicyBound"].some(f => Object.hasOwn(input, f) && (input[f] ?? null) !== (prior[f] ?? null))) throw new Error("Bound financial terms are immutable. Record a reviewed adjustment instead.");
      if (["brokerFeeReportingKey","brokerFeeCollected","brokerFeeRefunded","brokerFeeCollectedAt"].some(key=>Object.hasOwn(input,key) && input[key]!==prior?.[key])) throw new Error("Actual broker fee receipts are server-owned.");
      if (prior?.commissionSnapshotId && Object.hasOwn(input, "policyNumber") && (input.policyNumber ?? null) !== (prior.policyNumber ?? null)) throw new Error("The Owner must update tracked policy numbers through Commissions so both records stay in sync.");
    }
    if (model === "Policy" && operation === "delete") throw new Error("Bound policies retain commission history and cannot be deleted.");
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
    if (Array.isArray(candidate.quoteIds)) for (const quoteId of candidate.quoteIds) {
      const quote = await this.requireRecord("Quote", id(quoteId));
      if (root !== await this.root("Quote", quote)) throw new AccessDenied();
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
      if (["write","delete"].includes(operation) && document.category === "BROKER_FEE_DISCLOSURE") throw new Error("Signed disclosures cannot be replaced or deleted.");
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
