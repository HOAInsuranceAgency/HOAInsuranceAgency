import { addCalendarDays, validCalendarDate } from "../../../shared/renewalPolicy";

export type QuoteOfferFilter = "all" | "expiring" | "expired";
export type QuoteOfferUrgency = "expired" | "today" | "soon";
export interface QuoteOffer {
  status?: string | null;
  offerExpiresAt?: string | null;
}

/** Unknown dates sort last; a policy's term is never an offer deadline. */
export function quoteOfferDate(quote: QuoteOffer): string | null {
  return validCalendarDate(quote.offerExpiresAt) ? quote.offerExpiresAt : null;
}

/**
 * A carrier offer remains valid THROUGH its recorded civil date, matching
 * usableQuote. Only quoted/presented offers need attention: drafts, submissions
 * and closed quotes must not inflate an expiry count. `today` is the agency day.
 */
export function quoteOfferUrgency(quote: QuoteOffer, today: string): QuoteOfferUrgency | null {
  const expiry = quoteOfferDate(quote);
  if (!["QUOTED", "PRESENTED"].includes(quote.status ?? "") || !expiry || !validCalendarDate(today)) return null;
  if (expiry < today) return "expired";
  if (expiry === today) return "today";
  return expiry <= addCalendarDays(today, 7) ? "soon" : null;
}

export function matchesQuoteOfferFilter(quote: QuoteOffer, filter: QuoteOfferFilter, today: string): boolean {
  if (filter === "all") return true;
  const urgency = quoteOfferUrgency(quote, today);
  return filter === "expired" ? urgency === "expired" : urgency === "today" || urgency === "soon";
}
