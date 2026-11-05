import {
  buildingKey,
  contactKey,
  lossKey
} from "../../../../shared/extractionKeys";
import { fmtMoney, type Account } from "../../lib/client";
import { str } from "../../lib/formCodec";

/**
 * AI document extraction: kick off the Claude extraction over the account's
 * OCR'd documents, then review each extracted field (value + confidence +
 * evidence) against the current record and apply the ones you accept.
 * Nothing is ever written without explicit review.
 */

export interface ExtractedField {
  value: string | number | boolean | null;
  confidence: "high" | "medium" | "low";
  evidence: string | null;
  source: string | null;
}

interface ExtractedContact {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  type?: string | null;
}

interface ExtractedLoss {
  dateOfLoss?: string | null;
  lineOfBusiness?: string | null;
  typeOfLoss?: string | null;
  description?: string | null;
  claimDate?: string | null;
  amountPaid?: string | null;
  amountReserved?: string | null;
  amountOfLoss?: string | null;
  claimOpen?: string | null;
}

export interface ExtractionResult {
  [key: string]: unknown;
  contacts?: ExtractedContact[];
  buildings?: ExtractedBuilding[];
  losses?: ExtractedLoss[];
  summary?: string;
  extractedAt?: string;
  documentCount?: number;
}

interface ExtractedBuilding {
  label?: string | null;
  sqft?: string | number | null;
  yearBuilt?: string | null;
  stories?: string | null;
  constructionType?: string | null;
  roofYear?: string | null;
  heatingYear?: string | null;
  wiringYear?: string | null;
  plumbingYear?: string | null;
}

/** A candidate worth showing: the model returned an entry with a name on it. */
export const namedContact = (c: ExtractedContact) => Boolean(c?.name?.trim());

/**
 * A loss the app can actually store: both required columns present.
 *
 * A loss run line with no date or no line of business cannot go on the ACORD
 * 125 — its rows are ordered by date and labelled by line — so a candidate
 * missing either is not shown rather than being offered and then rejected by
 * the model on write.
 */
export const usableLoss = (l: ExtractedLoss) =>
  Boolean(l?.dateOfLoss?.trim() && l?.lineOfBusiness?.trim());

/**
 * A building the app can store: the model gave it a name, a size, or both.
 *
 * An entry with neither is not a building the documents described — it is the
 * model filling an array slot — and offering it would put "Building 3" with
 * nothing in it on the Property tab.
 */
export const usableBuilding = (b: ExtractedBuilding) =>
  Boolean(b?.label?.trim()) || digits(b?.sqft) != null;

/** "Yes"/"No" from the model → the nullable column. Anything else is unknown. */
export function yesNo(v: string | null | undefined): boolean | null {
  if (/^y(es)?$/i.test(v ?? "")) return true;
  if (/^n(o)?$/i.test(v ?? "")) return false;
  return null;
}

/**
 * What a candidate would be written as: its natural key, and only the columns
 * the documents actually supported.
 *
 * One function per kind, used by both the review table and the apply path, so
 * the verdict a reviewer read is computed from the same payload that is about
 * to be written. Two separate derivations would eventually disagree, and the
 * disagreement would be invisible — the screen saying "no change" over a
 * write that changed something.
 *
 * Absence matters here. A key omitted from `supplied` is a column the
 * documents said nothing about: it is not compared, and it is not written, so
 * a hand-typed phone number survives an extraction that never mentioned one.
 */
interface Write {
  key: string;
  supplied: Record<string, unknown>;
}

/** Drops keys whose value is undefined, which is how "not supplied" is said. */
const given = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export function contactWrite(c: ExtractedContact): Write {
  return {
    key: contactKey(c),
    supplied: given({
      name: str(c.name),
      email: str(c.email),
      phone: str(c.phone),
      type: str(c.type),
    }),
  };
}

export function lossWrite(l: ExtractedLoss): Write {
  return {
    key: lossKey({ ...l, amountOfLoss: l.amountOfLoss ?? null }),
    supplied: given({
      dateOfLoss: str(l.dateOfLoss),
      lineOfBusiness: str(l.lineOfBusiness),
      typeOfLoss: str(l.typeOfLoss),
      description: str(l.description),
      claimDate: str(l.claimDate),
      amountPaid: digits(l.amountPaid) ?? undefined,
      amountReserved: digits(l.amountReserved) ?? undefined,
      amountOfLoss: digits(l.amountOfLoss) ?? undefined,
      claimOpen: yesNo(l.claimOpen) ?? undefined,
    }),
  };
}

export function buildingWrite(b: ExtractedBuilding, i: number): Write {
  // Named before the key is taken, not after: the row that gets stored says
  // "Building 3", so that is what a later extraction has to match against.
  const label = b.label?.trim() || `Building ${i + 1}`;
  return {
    key: buildingKey({ label }),
    supplied: given({
      label,
      sqft: digits(b.sqft) ?? undefined,
      // The seven construction answers arrive per building. They used to be
      // flat fields patched onto the Account, which gave a thirteen-building
      // association one year built and one construction class for the site.
      yearBuilt: digits(b.yearBuilt) ?? undefined,
      stories: digits(b.stories) ?? undefined,
      constructionType: b.constructionType || undefined,
      roofYear: digits(b.roofYear) ?? undefined,
      heatingYear: digits(b.heatingYear) ?? undefined,
      wiringYear: digits(b.wiringYear) ?? undefined,
      plumbingYear: digits(b.plumbingYear) ?? undefined,
    }),
  };
}

// Field definitions: extraction key → label, current-value accessor, and
// how the value lands on the Account record ("patch") or in notes ("note").
export interface FieldDef {
  key: string;
  label: string;
  kind: "patch" | "note";
  vtype?: "int" | "float" | "bool"; // coercion for apply; default string
  current: (a: Account) => string;
  display?: (v: ExtractedField["value"]) => string;
  /** Lead-only field — hidden once the account is a client. */
  leadOnly?: boolean;
}

export const fmtVal = (v: ExtractedField["value"]): string => {
  if (v == null || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
};

// Values arrive as strings ("" = not found). Coerce to the Account field's
// type before writing.
export const isEmpty = (v: ExtractedField["value"]) => v == null || v === "";

/**
 * A digit string from the model → the integer column, or `null`.
 *
 * The model is asked for digits only and mostly obliges, but "1,985" and
 * "12,000 sq ft" both turn up. Not `formCodec.num`, which returns `null` for
 * both of those by design — this is the tolerant parser for text the model
 * wrote, which is a different job with a different answer.
 */
export function digits(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Math.round(Number(String(v).replace(/[^0-9.]/g, "")));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function coerce(def: FieldDef, v: ExtractedField["value"]): unknown {
  if (isEmpty(v)) return undefined;
  const s = String(v).trim();
  if (def.vtype === "int") {
    const n = Math.round(Number(s.replace(/[^0-9.-]/g, "")));
    return Number.isFinite(n) ? n : undefined;
  }
  if (def.vtype === "float") {
    const n = Number(s.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  if (def.vtype === "bool") return /^(yes|true|y)$/i.test(s);
  return s;
}

const moneyDisplay = (v: ExtractedField["value"]): string => {
  if (isEmpty(v)) return "—";
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? fmtMoney(n) : fmtVal(v);
};

// The four flat `contact*` fields are gone from here: contacts are rows now,
// reviewed in their own section below, because a prior policy packet names
// several people and this table can only ever patch one of each column.
const ALL_FIELD_DEFS: FieldDef[] = [
  { key: "address", label: "Street address", kind: "patch", current: (a) => a.address ?? "" },
  { key: "city", label: "City", kind: "patch", current: (a) => a.city ?? "" },
  { key: "state", label: "State", kind: "patch", current: (a) => a.state ?? "" },
  { key: "zip", label: "ZIP", kind: "patch", current: (a) => a.zip ?? "" },
  { key: "unitCount", label: "Unit count", kind: "patch", vtype: "int", current: (a) => a.unitCount?.toString() ?? "" },
  {
    key: "totalInsuredValue",
    label: "Total insured value",
    kind: "patch",
    vtype: "float",
    current: (a) => (a.totalInsuredValue != null ? fmtMoney(a.totalInsuredValue) : ""),
    display: moneyDisplay,
  },
  { key: "coastal", label: "Coastal", kind: "patch", vtype: "bool", current: (a) => (a.coastal == null ? "" : a.coastal ? "Yes" : "No") },
  { key: "milesToCoast", label: "Miles to coast", kind: "patch", vtype: "float", current: (a) => a.milesToCoast?.toString() ?? "" },
  { key: "firewallsVerified", label: "Firewalls verified", kind: "patch", vtype: "bool", current: (a) => (a.firewallsVerified == null ? "" : a.firewallsVerified ? "Yes" : "No") },
  { key: "currentAgent", label: "Current agent / broker", kind: "patch", current: (a) => a.currentAgent ?? "" },
  { key: "currentCarrier", label: "Current carrier → notes", kind: "note", current: () => "" },
  {
    key: "currentAnnualPremium",
    label: "Current premium → notes",
    kind: "note",
    current: () => "",
    display: moneyDisplay,
  },
  {
    key: "currentPolicyExpiration",
    label: "Current policy expiration",
    kind: "patch",
    // Clients renew off their bound policies, so this never applies to them.
    leadOnly: true,
    current: (a) => a.currentPolicyExpiration ?? "",
  },
  /**
   * Premium-finance eligibility facts → NOTES, deliberately, though the real
   * fields live on the Policy record. Two reasons: extraction is
   * account-scoped and cannot know which policy row a value belongs to, and
   * those fields BLOCK a lending decision — a low-confidence model read must
   * never be one click from becoming the answer. A person copies the value
   * onto the policy, which is the confirmation step the signed spec requires.
   */
  {
    key: "minimumEarnedPremiumPct",
    label: "Minimum earned premium % → notes",
    kind: "note",
    current: () => "",
  },
  // (isAuditable retired from extraction 2026-08-24 with the auditable
  // screen — "everything we do is final once entered".)
];

/** Clients renew off bound policies, so lead-only fields drop out entirely. */
export const fieldDefsFor = (account: Account): FieldDef[] =>
  account.stage === "CLIENT"
    ? ALL_FIELD_DEFS.filter((d) => !d.leadOnly)
    : ALL_FIELD_DEFS;

export function parseExtraction(raw: unknown): ExtractionResult | null {
  let v: unknown = raw;
  try {
    if (typeof v === "string") v = JSON.parse(v);
    if (typeof v === "string") v = JSON.parse(v);
  } catch {
    return null;
  }
  return v && typeof v === "object" ? (v as ExtractionResult) : null;
}
