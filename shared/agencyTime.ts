/** Instant-to-day conversion for agency business and reporting, not date-only fields. */
export const AGENCY_TIME_ZONE = 'America/New_York';
const dayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: AGENCY_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

/** Invalid instants throw; callers retain their own validation and fallback rules. */
export function agencyDay(at: string | number | Date): string {
  const parts = dayFormatter.formatToParts(at instanceof Date ? at : new Date(at));
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
