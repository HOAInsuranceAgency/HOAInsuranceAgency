import { generateClient } from "aws-amplify/data";
import type { Schema } from "../../amplify/data/resource";

export const client = generateClient<Schema>();

export type Account = Schema["Account"]["type"];
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
