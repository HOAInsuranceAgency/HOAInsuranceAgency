import { localHour, morningReminderAt, nextReminderMorning } from "./leadWorkflow";

export const addCalendarDays = (day: string, count: number) => new Date(Date.parse(`${day}T12:00:00Z`) + count * 86400_000).toISOString().slice(0, 10);
export function validCalendarDate(day?: string | null): day is string {
  return !!day && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
}
export function annualReturn(expiration: string, holidays: string[], now: string) {
  if (!validCalendarDate(expiration)) throw new Error("Record the incumbent expiration date first");
  const year = Number(expiration.slice(0, 4)) + 1;
  let next = `${year}${expiration.slice(4)}`;
  if (!validCalendarDate(next) && expiration.endsWith("-02-29")) next = `${year}-02-28`;
  if (!validCalendarDate(next)) throw new Error("Check the incumbent expiration date");
  const threshold = addCalendarDays(next, -90);
  const scheduled = morningReminderAt(new Date(localHour(threshold, 9)).toISOString(), holidays);
  return { expiration: next, returnAt: scheduled < now ? nextReminderMorning(now, holidays) : scheduled, threshold, stale: next <= now.slice(0, 10) };
}
export interface QuoteEvidence {
  id?: string; accountId: string; carrierId?: string | null; status?: string | null;
  lines?: (string | null)[] | null; effectiveDate?: string | null; expirationDate?: string | null;
  premium?: number | null; offerExpiresAt?: string | null; renewalPolicyId?: string | null;
}
export interface RiskTerm { accountId: string; carrierId?: string; policyId?: string; term: string; lines: string[] }
const normalized = (lines: (string | null)[]) => lines.filter((s): s is string => !!s).map(s => s.trim().toLowerCase());
/** Quoting a different term or line is not evidence that this requirement is met. */
export function quoteMatchesRisk(quote: QuoteEvidence, risk: RiskTerm) {
  return quote.accountId === risk.accountId && (!risk.carrierId || quote.carrierId === risk.carrierId)
    && quote.effectiveDate === risk.term && (risk.policyId ? quote.renewalPolicyId === risk.policyId : !quote.renewalPolicyId)
    && validCalendarDate(quote.expirationDate) && quote.expirationDate > risk.term;
}
export function usableQuote(quote: QuoteEvidence, risk: RiskTerm, now: string) {
  const today = /^\d{4}-\d{2}-\d{2}$/.test(now) ? now : new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
  return quoteMatchesRisk(quote, risk) && ["QUOTED", "PRESENTED", "BOUND"].includes(quote.status ?? "")
    && !!quote.carrierId && quote.premium != null && quote.premium > 0 && !!quote.lines?.filter(Boolean).length
    && (quote.status === "BOUND" || !quote.offerExpiresAt || validCalendarDate(quote.offerExpiresAt) && quote.offerExpiresAt >= today);
}
export function quoteCoverage(quotes: QuoteEvidence[], risk: RiskTerm, now: string) {
  const matches = quotes.filter(q => usableQuote(q, risk, now));
  const covered = new Set(matches.flatMap(q => normalized(q.lines ?? [])));
  // Unknown required lines need review; a random quote cannot prove completeness.
  return { quotes: matches, missingLines: risk.lines.filter(l => !covered.has(l.trim().toLowerCase())), complete: risk.lines.length > 0 && risk.lines.every(l => covered.has(l.trim().toLowerCase())) };
}

/** Legacy renewals are inferred only from a unique actual policy term and coverage match. */
export function scopeLegacyQuotes<T extends QuoteEvidence>(quotes: T[], policies: { id: string; accountId: string; expirationDate?: string | null; lines?: (string | null)[] | null }[]) {
  const ambiguous: string[] = [];
  const scoped = quotes.map(q => {
    if (q.renewalPolicyId) return q;
    const matches = policies.filter(p => p.accountId === q.accountId && p.expirationDate === q.effectiveDate && normalized(p.lines ?? []).some(l => normalized(q.lines ?? []).includes(l)));
    if (matches.length === 1) return { ...q, renewalPolicyId: matches[0].id };
    if (matches.length > 1) { if (q.id) ambiguous.push(q.id); return { ...q, renewalPolicyId: "unresolved-policy-context" }; }
    return q;
  });
  return { quotes: scoped, ambiguous };
}
