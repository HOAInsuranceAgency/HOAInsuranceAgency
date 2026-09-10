/** Compact labels for the Front panel; stored values and deadlines stay intact. */
export function leadSourceLabel(source?: string): string {
  if (!source) return "CRM lead";
  if (source === "website") return "Website enquiry";
  if (source.startsWith("website-ho6:")) return "HO-6 association form";
  if (source.startsWith("website-assessment:")) return "Insurance assessment";
  if (source === "website-quote") return "Quote request";
  if (source === "website-contact") return "Contact form";
  if (source === "website-coverage-calculator") return "Coverage calculator";
  return source.startsWith("website-") ? "Website enquiry" : source;
}

export function compactDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
    hour: "numeric", minute: "2-digit" }).format(date);
}

export const communicationChannelLabels: Record<string, string> = { ALL: "All activity", EMAIL: "Email", CALL: "Calls", SMS: "Texts", NOTE: "Notes" };
