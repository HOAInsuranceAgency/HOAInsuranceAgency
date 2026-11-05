import type { CommunicationReadOperationName, CommunicationWriteOperationName } from '../../../shared/apiOperations';
/** Client-visible operation contracts. SDK model imports are type-only. */
import type { Account, Contact, Policy, Quote } from './client';
import type { LeadWorkflow, LeadTask, WorkflowContext, IntegrationConfig, TeamEligibility, Communication } from '../../../shared/leadWorkflow';
import type { LeadSnooze } from '../../../shared/leadSnooze';
import type { CommercialPlan } from '../../../shared/quotePackages';
import type { DashboardLeadSelection } from '../../../shared/dashboardLeadSelection';
import type { PartyRecord, AccountRelationshipRecord, AffiliationRecord, RelationshipRole } from '../../../shared/relationships';
import type { BusinessDeliveryContext, BusinessDeliveryPreview, BusinessDeliveryAttempt, BusinessDeliverySelection, PrepareBusinessDraftInput, ReconcileBusinessDraftInput } from '../../../shared/frontBusinessDelivery';

/** The decoder consumes the transport ok flag; callers use the domain payload. */
export interface ApiAccepted { notice?: string }
export interface ApiPage<T> { items: T[]; nextToken?: string }
interface Operation<I, R> { input: I; result: R & ApiAccepted }
type EmptyInput = { [key: string]: never };
export type WorkKind = 'TRIAGE' | 'ISSUE' | 'OPERATION' | 'EVENT';
export type WorkItem = Partial<LeadTask & LeadWorkflow> & {
  id: string; version: number; message?: string; at?: string; state?: string; error?: string;
  communicationId?: string; phone?: string; urgency?: string; why?: string; instruction?: string; provider?: string; type?: string; resolved?: boolean;
};
export type WorkPage = ApiPage<WorkItem>;
export type CredentialName = 'frontToken' | 'frontSigningKey' | 'dialpadToken' | 'dialpadSigningKey';
export type CredentialPatch = Partial<Record<CredentialName, string>>;
export interface ConnectionCheck { name: string; ok: boolean; detail: string }
export interface CommunicationSettingsSnapshot {
  config: IntegrationConfig; recovery?: Record<string, { version: number; checkedAt?: string }>;
  credentialStatus: Record<string, boolean>; webhookUrl?: string; alertTopicArn?: string; sidebarUrl?: string;
  health?: { at?: string; lagging?: boolean };
}
export interface AccountCommunicationSummary {
  name: string; source?: string; leadSource?: string; notes?: string; currentPolicyExpiration?: string; url: string; more: boolean;
  contacts: { id: string; name?: string; email?: string; phone?: string }[];
  quotes: { id: string; status: string; lines?: string[] }[];
  documents: { id: string; name: string; status?: string }[];
}
export interface CommercialEntry {
  accountId: string; plan: CommercialPlan; salespersonId?: string; snooze?: LeadSnooze;
  workflowVersion?: number; disposition?: LeadWorkflow['disposition'];
}
export interface ReportAccount { id: string; name: string; leadSource?: string | null; source?: string | null }
export interface ContactStamp { at: string; channel: string; direction: string }
export type CompactQuote = Pick<Quote, 'id' | 'accountId' | 'status'>;
export type BoundPolicy = Pick<Policy, 'id' | 'accountId' | 'datePolicyBound'>;
export interface FinancePaymentReceipt { id: string; accountId: string; postedAt: string; interest: number | null }
export interface FinancePolicyAnchor { id: string; accountId: string; quoteId?: string | null }
export interface FinanceLineReceipt { id: string; invoiceId: string; policyId?: string | null }
export interface PortfolioItem { id: string; relationship: AccountRelationshipRecord; account: { id: string; name: string; stage: string } }
export interface LegacyManagerCandidate { id: string; contact: Contact; accountName: string }
export type EligibilityPatch = Partial<Pick<TeamEligibility, 'receiveNewLeads' | 'frontId' | 'frontChannelId' | 'frontSignatureId' | 'dialpadId'>>;
export type CommercialChange =
  | { action: 'ESTIMATE'; amount: string | null }
  | { action: 'SAVE_OPTION'; optionId?: string; name: string; quoteIds: string[] }
  | { action: 'SELECT'; optionId: string; clientSelected: boolean }
  | { action: 'REMOVE_OPTION'; optionId: string }
  | { action: 'CLEAR_SELECTION' };
export interface PartyDraft {
  kind: PartyRecord['kind']; name: string; category: string; email: string; phone: string;
  website: string; notes: string; ownerId: string; archived: boolean;
}
export interface NewLeadFields {
  name: string; stage?: string; type?: Account['type']; propertyType?: Account['propertyType'];
  address?: string; city?: string; state?: string; zip?: string; unitCount?: number; totalInsuredValue?: number;
  currentAgent?: string; currentPolicyExpiration?: string; leadSource?: string; notes?: string;
}

export interface CommunicationReadContracts {
  team: Operation<EmptyInput, { team: TeamEligibility[]; actorId?: string }>;
  teamSettings: Operation<{ userIds: string[] }, { team: TeamEligibility[] }>;
  settings: Operation<EmptyInput, CommunicationSettingsSnapshot>;
  smsComposer: Operation<EmptyInput, { channelId: string; sender: string }>;
  context: Operation<{ accountId?: string; conversationId?: string; nextToken?: string }, WorkflowContext>;
  activity: Operation<{ id: string; accountId?: string }, { communication: Communication | null }>;
  accountSummary: Operation<{ accountId: string }, { summary: AccountCommunicationSummary }>;
  searchAccounts: Operation<{ query: string; nextToken?: string }, ApiPage<{ id: string; name: string }>>;
  work: Operation<{ kind: WorkKind; view?: string; mine?: boolean; nextToken?: string }, WorkPage>;
  businessDeliveryContext: Operation<{ accountId: string }, { context: BusinessDeliveryContext }>;
  historyBusinessDeliveries: Operation<{ accountId: string; nextToken?: string }, ApiPage<BusinessDeliveryAttempt>>;
  relationshipSearch: Operation<{ query?: string; kind?: string; archived?: boolean; nextToken?: string }, ApiPage<PartyRecord>>;
  relationshipProfiles: Operation<{ ids: string[] }, ApiPage<PartyRecord>>;
  relationshipContext: Operation<{ accountId: string; nextToken?: string }, { relationships: AccountRelationshipRecord[]; version: number; selfManagedFrom?: string; nextToken?: string }>;
  relationshipPortfolio: Operation<{ partyId: string; nextToken?: string }, ApiPage<PortfolioItem>>;
  relationshipAffiliations: Operation<{ partyId: string; nextToken?: string }, ApiPage<AffiliationRecord & { relatedName: string }>>;
  relationshipLegacyCandidates: Operation<{ nextToken?: string }, ApiPage<LegacyManagerCandidate>>;
  commercialTable: Operation<{ accountIds: string[]; snoozeAccountIds?: string[] }, { items: CommercialEntry[] }>;
  dashboardAssignments: Operation<{ accountIds: string[] }, { items: Omit<CommercialEntry, 'plan'>[]; accounts: ReportAccount[] }>;
  dashboardInterestPage: Operation<{ from: string; to: string; nextToken?: string }, ApiPage<FinancePaymentReceipt>>;
  dashboardPolicyAnchors: Operation<{ policyIds: string[] }, { items: FinancePolicyAnchor[]; missingIds: string[] }>;
  dashboardInvoiceAnchors: Operation<{ invoiceIds: string[]; nextToken?: string }, ApiPage<FinanceLineReceipt>>;
  dashboardQuotesPage: Operation<{ accountIds: string[]; details?: boolean; nextToken?: string }, ApiPage<CompactQuote>>;
  dashboardOpenQuotesPage: Operation<{ status: string; nextToken?: string }, ApiPage<CompactQuote>>;
  dashboardBoundPoliciesPage: Operation<{ from: string; to: string; nextToken?: string }, ApiPage<BoundPolicy>>;
  dashboardQuoteStates: Operation<{ quoteIds: string[] }, { items: CompactQuote[]; missingIds: string[] }>;
  dashboardLeadPlansPage: Operation<{ nextToken?: string }, ApiPage<DashboardLeadSelection>>;
  lastContacts: Operation<{ accounts: { accountId: string; nextToken?: string }[] }, { items: { accountId: string; contact: ContactStamp | null; complete: boolean; nextToken?: string }[] }>;
}
export interface CommunicationWriteContracts {
  setResponsibilities: Operation<{ accountId: string; salespersonId: string; version: number }, { workflow: LeadWorkflow }>;
  saveEligibility: Operation<{ userId: string; version: number } & EligibilityPatch, { member: TeamEligibility }>;
  saveSettings: Operation<{ config: IntegrationConfig; credentials?: CredentialPatch }, { config: IntegrationConfig }>;
  validateConnection: Operation<EmptyInput, { checks: ConnectionCheck[] }>;
  activate: Operation<{ nativeChecksConfirmed: boolean }, { config: IntegrationConfig }>;
  restartReconciliation: Operation<{ provider: 'front' | 'dialpad'; version: number; reason: string }, ApiAccepted>;
  restartConversationHistory: Operation<{ conversationId: string; reason: string }, ApiAccepted>;
  backfill: Operation<{ nextToken?: string | null }, { assigned: number; exceptions: number; nextToken?: string }>;
  linkConversation: Operation<{ accountId: string; conversationId: string; purpose: 'PROSPECT' | 'CARRIER'; context?: 'LEAD' | 'RENEWAL' | 'SERVICE'; policyId?: string }, ApiAccepted>;
  linkActivity: Operation<{ id: string; accountId: string; conversationId?: string; version: number; purpose: 'PROSPECT' | 'CARRIER' }, ApiAccepted>;
  reviewIssue: Operation<{ id: string; version: number; reason: string; replay: boolean }, ApiAccepted>;
  reviewOperation: Operation<{ id: string; version: number; state?: string; action: 'resolve' | 'retry' | 'suppress'; uid: string; reason: string; verifiedNotSent: boolean }, ApiAccepted>;
  initializeLead: Operation<{ accountId: string }, ApiAccepted>;
  refreshSeen: Operation<{ id: string }, ApiAccepted>;
  saveAttachment: Operation<{ communicationId: string; attachmentId: string }, ApiAccepted>;
  addNote: Operation<{ accountId: string; text: string; publishToFront: boolean; requestId: string }, ApiAccepted>;
  setLeadDisposition: Operation<{ accountId: string; version: number; disposition: LeadWorkflow['disposition'] }, ApiAccepted>;
  cancelAi: Operation<{ accountId: string; version: number }, ApiAccepted>;
  routeConversation: Operation<{ conversationId?: string; role: 'SALESPERSON' }, ApiAccepted>;
  saveLeadSnooze: Operation<{ accountId: string; version: number; followUpOn: string | null; note: string }, { snooze: LeadSnooze }>;
  saveCommercial: Operation<{ accountId: string; version: number } & CommercialChange, { plan: CommercialPlan }>;
  authorizeBind: Operation<{ quoteId: string; updatedAt: string; clientAuthorized: boolean }, ApiAccepted>;
  previewBusinessDelivery: Operation<BusinessDeliverySelection, { preview: BusinessDeliveryPreview }>;
  prepareBusinessDraft: Operation<PrepareBusinessDraftInput, { attempt: BusinessDeliveryAttempt }>;
  reconcileBusinessDraft: Operation<ReconcileBusinessDraftInput, { attempt: BusinessDeliveryAttempt }>;
  relationshipSaveParty: Operation<PartyDraft & { id?: string; revision: number; requestId: string }, { party: PartyRecord }>;
  relationshipLink: Operation<{ accountId: string; partyId: string; role: RelationshipRole; validFrom?: string | null; notes?: string; requestId: string }, ApiAccepted>;
  relationshipEnd: Operation<{ accountId: string; id: string; revision: number; validUntil: string; requestId: string }, ApiAccepted>;
  relationshipChangeManagement: Operation<{ accountId: string; version: number; partyId: string | null; effectiveOn: string; generalPartyId: string | null; billingPartyId: string | null; inspectionPartyId: string | null; retireContactIds: string[]; notes: string; requestId: string }, ApiAccepted>;
  relationshipSaveAffiliation: Operation<{ id?: string; revision: number; personId: string; organizationId: string; title: string; validFrom: string | null; validUntil: string | null; requestId: string }, ApiAccepted>;
  createLead: Operation<{ requestId: string; salespersonId?: string; fields: NewLeadFields }, { id: string }>;
  prepareLeadDeletion: Operation<{ accountId: string; name: string }, ApiAccepted>;
}
export type CommunicationReadOperation = CommunicationReadOperationName;
export type CommunicationWriteOperation = CommunicationWriteOperationName;
export type CommunicationContracts = CommunicationReadContracts & CommunicationWriteContracts;
export type CommunicationOperation = keyof CommunicationContracts;
export type CommunicationInput<K extends CommunicationOperation> = CommunicationContracts[K]['input'];
export type CommunicationResult<K extends CommunicationOperation> = CommunicationContracts[K]['result'];
