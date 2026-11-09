import { client } from './client';
import { isRecord, privateApiCall } from './apiResponse';
import type { ApiRecord, ApiResponse } from '../../../shared/apiResponse';

const ok = (value: ApiRecord): value is ApiRecord & { ok: true } => value.ok === true;
async function acceptedOperation(response: Promise<ApiResponse>, fallback: string): Promise<void> {
  await privateApiCall(response, ok, { fallback });
}
export async function reserveInvoiceNumber(): Promise<string> {
  const value = await privateApiCall(client.mutations.reserveInvoiceNumber(),
    (value): value is ApiRecord & { invoiceNumber: string } => typeof value.invoiceNumber === 'string' && !!value.invoiceNumber,
    { requireOk: false, fallback: "Couldn't reserve an invoice number. Nothing was created; try again." });
  return value.invoiceNumber;
}
export async function createGroupedInvoice(input: { accountId: string; policyIds: string[] }): Promise<string> {
  const result = await privateApiCall(client.mutations.createGroupedInvoice(input),
    (value): value is ApiRecord & { ok: true; invoiceId: string } => value.ok === true && typeof value.invoiceId === 'string' && !!value.invoiceId,
    { fallback: "Couldn't combine the selected policies." });
  return result.invoiceId;
}
export async function restoreGroupedInvoice(invoiceId: string): Promise<void> {
  await acceptedOperation(client.mutations.restoreGroupedInvoice({ invoiceId }), "Couldn't restore the separate drafts.");
}
export async function reserveCertificateNumber(): Promise<string> {
  const value = await privateApiCall(client.mutations.reserveCertificateNumber(),
    (value): value is ApiRecord & { certificateNumber: string } => typeof value.certificateNumber === 'string' && !!value.certificateNumber,
    { requireOk: false, fallback: "Couldn't reserve a certificate number. Nothing was saved; try again." });
  return value.certificateNumber;
}
export async function voidInvoice(invoiceId: string): Promise<void> {
  await acceptedOperation(client.mutations.voidInvoice({ invoiceId }), 'Void failed.');
}
interface InvoiceSendResult { ok: true; sentAt?: string; sentTo?: string }
export async function sendInvoice(input: { invoiceId: string; toEmail?: string; expectedSentAt?: string }): Promise<InvoiceSendResult> {
  return await privateApiCall(client.mutations.sendInvoice(input),
    (value): value is ApiRecord & InvoiceSendResult => value.ok === true && ['sentAt', 'sentTo'].every(key => value[key] === undefined || typeof value[key] === 'string'),
    { fallback: 'Send failed.' });
}
export interface FinanceServiceInput {
  loanId: string; action: string; policyId?: string; noticeId?: string;
  certMailedAt?: string; certNumber?: string; cancellationEffectiveAt?: string;
  boardResolutionExecutedAt?: string; boardResolutionDocumentId?: string;
}
export interface FinanceServiceResult { ok: true; posted?: { n?: number } }
export async function serviceFinanceLoan(input: FinanceServiceInput): Promise<FinanceServiceResult> {
  return await privateApiCall(client.mutations.servicePfLoan(input),
    (value): value is ApiRecord & FinanceServiceResult => value.ok === true && (value.posted === undefined || isRecord(value.posted) && (value.posted.n === undefined || typeof value.posted.n === 'number' && Number.isSafeInteger(value.posted.n))),
    { fallback: 'Refused.' });
}
export async function generateFinanceAgreement(loanId: string): Promise<void> {
  await acceptedOperation(client.mutations.generatePfAgreement({ loanId }), 'Generation failed.');
}
