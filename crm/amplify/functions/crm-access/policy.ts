/** Every model must be classified; synth fails when a new model is not listed. */
export const ACCOUNT_MODELS = ["Account", "Contact", "PriorCarrier", "Activity", "Loss", "Blanket", "GlApplication", "GlClassCode", "DoCoveragePart", "DoApplication", "Building", "Quote", "Policy", "Invoice", "InvoiceLine", "PfComplianceLog", "PfLoan", "PfLoanPayment", "PfNotice", "PfOverride", "Document", "MarketingTask", "Certificate", "LeadReply", "UploadPortal", "HoneycombEstimate", "HoneycombSubmission"] as const;
export const SHARED_MODELS = ["Carrier", "AppetiteGuide", "PfCounselOpinion", "UserProfile", "ProducerLicense", "License", "AgencySettings", "LicenseReminder"] as const;
export const PUBLIC_OPERATIONS = ["webLeadEstimate", "leadIntakeReady", "submitWebLead", "requestLeadUpload", "closeLeadUploadWindow", "uploadPortalStatus", "requestPortalUpload", "financeElectionTerms", "acceptFinanceElection"];
export const ADMIN_OPERATIONS = ["inviteUser", "listTeamUsers", "setPremiumFinanceEnabled"];
export const CUSTOM_OPERATIONS = ["communicationRead", "communicationWrite", "honeycombSubmissionSettings", "startHoneycombSubmission", "resolveHoneycombSubmission", "startLeadExtraction", "suggestFormFields", "reserveCertificateNumber", "reserveInvoiceNumber", "sendInvoice", "voidInvoice", "issueFinanceQuote", "generatePfAgreement", "servicePfLoan", "crmAccess", "crmFile"];
export const ACCOUNT_REFERENCES: Record<string, Record<string, string>> = {
  Quote: { renewalPolicyId: "Policy" }, Policy: { quoteId: "Quote" }, Invoice: { policyId: "Policy", quoteId: "Quote" },
  InvoiceLine: { invoiceId: "Invoice", policyId: "Policy" }, PfLoan: { policyId: "Policy", quoteId: "Quote", boardResolutionDocumentId: "Document" },
  PfLoanPayment: { loanId: "PfLoan" }, PfNotice: { loanId: "PfLoan", refNoticeId: "PfNotice", certDocumentId: "Document" },
  PfOverride: { policyId: "Policy" }, Document: { policyId: "Policy", quoteId: "Quote" },
  MarketingTask: { policyId: "Policy" }, HoneycombSubmission: { sourceEstimateId: "HoneycombEstimate" },
};
export type RecordData = Record<string, unknown>;
export type Identity = { sub?: string; groups?: string[]; claims?: Record<string, unknown> };
export class AccessDenied extends Error { constructor() { super("This record is not available to your account. Contact your manager if it needs to be assigned to you."); this.name = "Unauthorized"; } }
export const object = (value: unknown): RecordData => {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as RecordData;
};
export const id = (value: unknown): string => typeof value === "string" && value.length > 0 && value.length <= 500 ? value : "";
