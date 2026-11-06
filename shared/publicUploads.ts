import { isHttpsUrl, isRecord, type ApiFailure } from './apiResponse';

/** Public upload responses expose checklist counts, never account or document records. */
export interface PortalSection {
  key: string;
  label: string;
  help: string;
  received: number;
}
export interface PortalStatus {
  associationName: string;
  expiresAt: string;
  uploadCount: number;
  maxFiles: number;
  full: boolean;
  sections: PortalSection[];
}
export type PortalStatusResponse = ({ ok: true } & PortalStatus) | ApiFailure;

/** Full producer receipts; the browser needs only the signed upload destination. */
export interface UploadDestination { uploadUrl: string; }
export interface UploadReservationReceipt extends UploadDestination {
  ok: true;
  documentId: string;
  uploadCount: number;
}
export type LeadUploadResponse = UploadReservationReceipt | ApiFailure;
export type PortalUploadResponse = (UploadReservationReceipt & { category: string }) | ApiFailure;
export type CloseLeadUploadResponse = { ok: true; alreadyClosed?: true } | ApiFailure;

const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function isPortalSection(value: unknown): value is PortalSection {
  return isRecord(value) && typeof value.key === 'string' && typeof value.label === 'string'
    && typeof value.help === 'string' && count(value.received);
}

/** Validate the existing wire fields and project only the page's public whitelist.
 * The transport has already checked ok and decoded AWSJSON. */
export function readPortalStatus(value: unknown): PortalStatus | undefined {
  if (!isRecord(value) || typeof value.associationName !== 'string' || typeof value.expiresAt !== 'string'
    || typeof value.full !== 'boolean' || !count(value.uploadCount) || !count(value.maxFiles)
    || !Array.isArray(value.sections) || !value.sections.every(isPortalSection)) return undefined;
  return {
    associationName: value.associationName, expiresAt: value.expiresAt,
    uploadCount: value.uploadCount, maxFiles: value.maxFiles, full: value.full,
    sections: value.sections.map(section => ({ key: section.key, label: section.label, help: section.help, received: section.received })),
  };
}

/** Older receipts need not contain metadata the page does not use. */
export function readUploadDestination(value: unknown): UploadDestination | undefined {
  return isRecord(value) && isHttpsUrl(value.uploadUrl) ? { uploadUrl: value.uploadUrl } : undefined;
}
