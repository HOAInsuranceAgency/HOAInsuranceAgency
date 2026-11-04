import { Badge } from "../lib/badges";
import { fmtDate } from "../lib/client";
import { quoteOfferDate, quoteOfferUrgency, type QuoteOffer } from "../lib/quoteOfferExpiry";
import "./QuoteOfferExpiry.css";

export default function QuoteOfferExpiry({ quote, today }: { quote: QuoteOffer; today: string }) {
  const expiry = quoteOfferDate(quote), urgency = quoteOfferUrgency(quote, today);
  if (!expiry) return <span className="muted">{quote.offerExpiresAt ? "Invalid date" : "Not recorded"}</span>;
  return <span className="quote-offer-expiry">
    <time dateTime={expiry}>{fmtDate(expiry)}</time>
    {urgency === "expired" && <Badge cls="red" label="Expired" />}
    {urgency === "today" && <Badge cls="amber" label="Expires today" />}
    {urgency === "soon" && <Badge cls="amber" label="Expires soon" />}
  </span>;
}
