/** Public CRM/Front handoff DTOs. Internal notes and commission never belong here. */
export type BusinessDeliveryKind = 'PACKAGE' | 'CERTIFICATE' | 'DOCUMENT';
export type BusinessDeliveryState = 'PREPARING' | 'DRAFT' | 'UNKNOWN' | 'FAILED' | 'SENT';
/** Cheap UI/source eligibility only; server separately verifies account/key/bytes. */
export function isBusinessDeliveryFile(file: { name?: string | null; contentType?: string | null; category?: string | null }, pdfOnly = false): boolean {
  if (['PF_AGREEMENT','PF_BOARD_RESOLUTION','PF_RESOLUTION_EXECUTED'].includes(file.category ?? '')) return false;
  const extension = file.name?.split('.').pop()?.toLowerCase(), mime = file.contentType?.toLowerCase();
  const types: Record<string, string[]> = { pdf:['application/pdf'],jpg:['image/jpeg'],jpeg:['image/jpeg'],png:['image/png'],gif:['image/gif'],tif:['image/tiff'],tiff:['image/tiff'],webp:['image/webp'],xlsx:['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],docx:['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],csv:['text/csv','application/csv'],txt:['text/plain'] };
  return !!extension && !!mime && (!pdfOnly || extension === 'pdf') && !!types[extension]?.includes(mime);
}
export interface BusinessDeliverySelection {
  accountId: string;
  kind: BusinessDeliveryKind;
  /** PACKAGE: reviewed commercial option ID; otherwise the selected source record ID. */
  recordId: string;
  /** NEW starts an unquoted conversation; an existing ID must be a linked client thread. */
  conversationId?: string;
  documentIds?: string[];
}
export interface BusinessDeliverySender {
  frontId: string; channelId: string; senderEmail: string; signatureId: string;
}
export interface PublicProposalQuote {
  id: string; carrierName: string; lines: string[]; premium: number;
  effectiveDate: string; expirationDate: string; offerExpiresAt?: string | null;
  perOccurrenceDeductible?: number | null; perUnitDeductible?: number | null;
  blanketLimit?: number | null; coinsurancePct?: number | null;
  replacementCostType?: string | null;
  glEachOccurrence?: number | null; glDamageToRentedPremises?: number | null;
  glMedicalExpense?: number | null; glPersonalAdvInjury?: number | null;
  glGeneralAggregate?: number | null; glProductsCompletedOps?: number | null;
  glClaimsMade?: boolean | null; glAggregateAppliesTo?: string | null;
  minimumEarnedPremiumPct?: number | null;
}
export interface BusinessDeliveryDocument {
  id: string; name: string; contentType: string; size?: number; category?: string;
}
export interface BusinessDeliveryChoice {
  kind: BusinessDeliveryKind; recordId: string; label: string; disabledReason?: string;
}
export interface BusinessDeliveryConversation { id: string; label: string; }
export interface BusinessDeliveryContext {
  accountId: string; accountName: string;
  choices: BusinessDeliveryChoice[]; documents: BusinessDeliveryDocument[];
  conversations: BusinessDeliveryConversation[];
  recipientSuggestions: { email: string; label: string }[];
  sender?: BusinessDeliverySender; senderError?: string;
}
export interface BusinessDeliveryAttachment extends BusinessDeliveryDocument { sha256: string; }
export interface BusinessDeliveryPreview {
  id: string; previewId: string; previewHash: string; selection: BusinessDeliverySelection;
  sender: BusinessDeliverySender; conversationId: string; conversationLabel: string;
  subject: string; body: string; facts: string[]; quotes: PublicProposalQuote[];
  attachments: BusinessDeliveryAttachment[]; warnings: string[]; expiresAt: string;
}
export interface PrepareBusinessDraftInput {
  accountId: string; previewId: string; previewHash: string; requestId: string;
  to: string[]; cc: string[]; conversationId?: string;
}
export interface ReconcileBusinessDraftInput {
  accountId: string; attemptId: string;
  /** Explicit user-assisted recovery; exact Front message/draft ID only, never a search query. */
  recoveryMessageId?: string;
}
export interface BusinessDeliveryAttempt {
  id: string; requestId: string; accountId: string;
  kind: BusinessDeliveryKind | 'QUOTE'; recordId: string;
  state: BusinessDeliveryState; from: string; to: string[]; cc: string[];
  conversationId: string; frontDraftId?: string; frontUrl?: string; messageUrl?: string;
  preparedAt: string; sentAt?: string; failure?: string;
}
