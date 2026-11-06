import { agencyDay } from '../../../shared/agencyTime';
export type DateRange = { from: string; to: string };
export type DateRangePreset = 'all' | 'ytd' | '12mo';
export type DateRangeValidation = {
  allowOpenEnded?: boolean;
  validate?: (from: string, to: string) => unknown;
};

/** Financial reports use the agency's civil day, independent of browser timezone. */
export function reportToday(now = new Date()): string {
  return agencyDay(now);
}

export function dateRangePreset(preset: DateRangePreset, today = reportToday()): DateRange {
  if (preset === 'all') return { from: '', to: '' };
  if (preset === 'ytd') return { from: `${today.slice(0, 4)}-01-01`, to: today };
  const year = Number(today.slice(0, 4)) - 1;
  const month = Number(today.slice(5, 7));
  const day = Math.min(Number(today.slice(8, 10)), new Date(Date.UTC(year, month, 0)).getUTCDate());
  return { from: `${year}-${today.slice(5, 7)}-${String(day).padStart(2, '0')}`, to: today };
}

function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.slice(0, 4) === '0000') return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function dateRangeError(value: DateRange, { allowOpenEnded = false, validate }: DateRangeValidation = {}): string {
  if ((!allowOpenEnded && (!value.from || !value.to)) || value.from && !isDay(value.from) || value.to && !isDay(value.to)) {
    return 'Choose a valid start and end date.';
  }
  if (value.from && value.to && value.from > value.to) return 'The start date must be on or before the end date.';
  try { validate?.(value.from, value.to); }
  catch (error) { return error instanceof Error ? error.message : 'Choose a valid start and end date.'; }
  return '';
}
