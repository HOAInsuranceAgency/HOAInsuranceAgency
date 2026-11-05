/** Pure presentation facade for fictional commercial records, never an SDK. */
export { listAllPages } from '../../shared/pagination';
export type { Account, Quote, Carrier, Contact, Policy } from '../src/lib/client';
export type { TeamEligibility } from '../../shared/leadWorkflow';
export const LINES_OF_BUSINESS = ['Property', 'General Liability', 'D&O', 'Umbrella', 'Crime'];
export const fmtMoney = (value?: number | null) => value == null ? '—'
  : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
export const fmtNum = (value?: number | null) => value == null ? '—' : String(value);
export const fmtDate = (value?: string | null) => value ? new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US') : '—';
export const fmtDateTime = (value?: string | null) => value ? new Date(value).toLocaleString('en-US') : '—';
export const daysUntil = (value: string) => Math.round((Date.parse(value) - Date.now()) / 86_400_000);
export const friendlyError = (error: unknown) => error instanceof Error ? error.message : String(error);
