import { generateClient } from "aws-amplify/data";
import type { Schema } from "../../amplify/data/resource";

export const client = generateClient<Schema>();

export type Account = Schema["Account"]["type"];
export type Building = Schema["Building"]["type"];
export type Quote = Schema["Quote"]["type"];
export type Policy = Schema["Policy"]["type"];
export type Carrier = Schema["Carrier"]["type"];
export type AppetiteGuide = Schema["AppetiteGuide"]["type"];
export type CrmDocument = Schema["Document"]["type"];
export type Certificate = Schema["Certificate"]["type"];
export type UserProfile = Schema["UserProfile"]["type"];
export type ProducerLicense = Schema["ProducerLicense"]["type"];

export const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC",
];

export const LINES_OF_BUSINESS = [
  "Property",
  "General Liability",
  "D&O",
  "Crime/Fidelity",
  "Umbrella",
  "Flood",
  "Earthquake",
  "Workers Comp",
  "HO-6",
];

export function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  return new Date(d + (d.length === 10 ? "T00:00:00" : "")).toLocaleDateString("en-US");
}

// ── Shared form validation ───────────────────────────────────────────
// Returns a list of human-readable problems; empty = valid. All fields
// optional — only filled-in values are checked.
export function validateAccountFields(f: {
  contactEmail?: string;
  zip?: string;
  unitCount?: string;
  yearBuilt?: string;
  totalInsuredValue?: string;
}): string[] {
  const problems: string[] = [];
  const email = f.contactEmail?.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    problems.push("Contact email doesn't look like a valid address.");
  }
  const zip = f.zip?.trim();
  if (zip && !/^\d{5}(-\d{4})?$/.test(zip)) {
    problems.push("ZIP should be 5 digits (or ZIP+4).");
  }
  if (f.unitCount) {
    const n = Number(f.unitCount);
    if (!Number.isInteger(n) || n < 0 || n > 100000)
      problems.push("Unit count should be a whole number of at least 0.");
  }
  if (f.yearBuilt) {
    const n = Number(f.yearBuilt);
    const maxYear = new Date().getFullYear() + 5;
    if (!Number.isInteger(n) || n < 1600 || n > maxYear)
      problems.push(`Year built should be between 1600 and ${maxYear}.`);
  }
  if (f.totalInsuredValue) {
    const n = Number(f.totalInsuredValue);
    if (!Number.isFinite(n) || n < 0)
      problems.push("Total insured value can't be negative.");
  }
  return problems;
}

/** Turn raw GraphQL/AppSync errors into something a human can act on. */
export function friendlyError(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const varMatch = msg.match(/Variable '(\w+)' has an invalid value/);
  if (varMatch) return `"${varMatch[1]}" has an invalid value — please check that field.`;
  if (/Not Authorized|Unauthorized/i.test(msg))
    return "You don't have permission to do that.";
  if (/Network(Error| error)|Failed to fetch/i.test(msg))
    return "Network problem — check your connection and try again.";
  return msg || fallback;
}
