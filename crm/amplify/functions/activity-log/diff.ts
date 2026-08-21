/**
 * What changed between two DynamoDB item images, in words.
 *
 * Separated from the handler so it can be tested without a stream, a Lambda
 * or an AWS account — which matters more here than usual, because the only
 * other way to exercise this code is to deploy it and edit a record.
 *
 * Nothing in this file imports anything. It is handed plain objects.
 */

/** One field's before and after, as the tab renders it. */
export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export type ActivityAction = "CREATE" | "UPDATE" | "DELETE";

/**
 * Fields that never count as a change.
 *
 * `updatedAt` moves on every write by definition, so including it would make
 * every diff non-empty and every no-op update produce an activity row.
 * `lastWriteBy` is the attribution mechanism itself — showing it as a change
 * would put "lastWriteBy: abc → def" in the timeline beside the change it
 * describes. The OCR and extraction blobs are megabytes of text nobody wants
 * rendered as a before/after, and `_version`/`_lastChangedAt` only exist if
 * conflict resolution is ever switched on.
 *
 * The identifiers below are here for a different reason, found by reading a
 * real timeline on staging: adding one contact rendered
 *
 *     Account id: — → 66904aa2-3dfe-4bc9-b606-3b4ea4bb3402
 *     Extraction source key: — → name:dana whitfield|
 *     Id: — → c675ec80-a7e4-4a81-8e4b-4083761b2096
 *     Is primary: — → Yes
 *     Name: — → Dana Whitfield
 *
 * — three lines of bookkeeping above the two a person came to read. None of
 * them can ever say anything: `id` is assigned and never changes, `accountId`
 * is the account whose timeline this already is, and `extractionSourceKey` is
 * the matching key W9 dedupes on.
 *
 * The line this list draws is whether a field describes the **association** or
 * the app's **bookkeeping about** the association. That is why
 * `extractionStatus` and `extractionError` are deliberately NOT here: an
 * extraction that ran and failed is an event somebody started and needs to
 * know about, and with `aiExtraction` filtered out those two columns are the
 * only trace of it left. `aiExtractionAppliedAt` is the other side of the
 * same line — a marker recording which result was applied, sitting on the
 * very update that already lists the fields it applied.
 *
 * Kept as an explicit list rather than a pattern like `/Id$/`: that would
 * also swallow `buildiumId`, which is the property manager's own reference
 * and exactly the kind of thing a producer would want to see change.
 */
export const NOISE_FIELDS: ReadonlySet<string> = new Set([
  "updatedAt",
  "createdAt",
  "lastWriteBy",
  "aiExtraction",
  "aiExtractionAppliedAt",
  "ocrText",
  "ocrTables",
  "__typename",
  "_version",
  "_lastChangedAt",
  "_deleted",
  // Identifiers — see the note above.
  "id",
  "accountId",
  "extractionSourceKey",
]);

/** Deep-ish equality: enough for the scalars, arrays and JSON blobs stored here. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => same(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/**
 * Every field that differs, ignoring the noise list.
 *
 * A field present in one image and absent from the other counts, because
 * clearing a value is a change — and an Amplify `update` that sets a column
 * to null is exactly how a user clears a field.
 */
export function diffImages(
  oldImage: Record<string, unknown> | undefined,
  newImage: Record<string, unknown> | undefined
): FieldChange[] {
  const keys = new Set([
    ...Object.keys(oldImage ?? {}),
    ...Object.keys(newImage ?? {}),
  ]);
  const changes: FieldChange[] = [];
  for (const field of keys) {
    if (NOISE_FIELDS.has(field)) continue;
    const from = oldImage?.[field] ?? null;
    const to = newImage?.[field] ?? null;
    if (!same(from, to)) changes.push({ field, from, to });
  }
  // Stable order, so two runs over the same event produce the same row.
  return changes.sort((a, b) => a.field.localeCompare(b.field));
}

/**
 * The account this record hangs off, or `null` when it hangs off nothing.
 *
 * Everything account-scoped carries `accountId` — except the account, which
 * IS the account and so carries none. `Account` was streamed from the start
 * and every one of its changes was silently dropped here for exactly that
 * reason: the tab claimed to show "every write to this account and everything
 * under it", and showed only the second half. Renaming the association,
 * setting its entity type, its annual revenue, its fire district, or
 * converting the lead to a client left no trace at all.
 *
 * `Document` is the other exception, for the opposite reason: it is
 * polymorphic, so its account id is in `entityId` and only when `entityType`
 * says so — a document attached to a carrier or a licence has an `entityId`
 * that is not an account, and filing it under one would put a licence upload
 * in some association's timeline.
 */
export function resolveEntityId(
  subjectType: string,
  image: Record<string, unknown> | undefined
): string | null {
  if (!image) return null;
  if (subjectType === "Account") {
    return typeof image.id === "string" ? image.id : null;
  }
  if (subjectType === "Document") {
    return image.entityType === "ACCOUNT" && typeof image.entityId === "string"
      ? image.entityId
      : null;
  }
  return typeof image.accountId === "string" ? image.accountId : null;
}

/**
 * A short human name for the record, for the timeline's "what" column.
 *
 * Falls through a list of the fields these models actually use as titles,
 * rather than being configured per model — a new streamed model then gets a
 * reasonable label for free instead of rendering a bare id.
 */
const LABEL_FIELDS = [
  "label",
  "name",
  "carrierName",
  "blanketNumber",
  "classCode",
  "certificateNumber",
  "policyNumber",
  // Before `policyNumber` would have been wrong: an invoice carries no policy
  // number of its own, but it does carry `number`, and a timeline row reading
  // "INV-2026-00001" beats one reading a uuid.
  "number",
  "part",
] as const;

export function subjectLabel(
  subjectType: string,
  image: Record<string, unknown> | undefined
): string {
  for (const f of LABEL_FIELDS) {
    const v = image?.[f];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  // A loss has no name; the date and line are what identifies it to a human.
  if (subjectType === "Loss" && typeof image?.dateOfLoss === "string") {
    const line = typeof image.lineOfBusiness === "string" ? ` ${image.lineOfBusiness}` : "";
    return `${image.dateOfLoss}${line}`;
  }
  return "";
}

/** A value as it should read inside a sentence. */
function readable(v: unknown): string {
  if (v == null || v === "") return "blank";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "blank";
  if (typeof v === "object") return "…";
  return String(v);
}

/** Space out a camelCase column into something readable. */
export function fieldLabel(field: string): string {
  const spaced = field.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * One sentence describing the event.
 *
 * Deliberately built here rather than in the UI: the row is the system of
 * record, a later reader should not have to re-derive what happened from a
 * diff, and the sentence is what a search over the timeline will match on.
 *
 * An update naming more than two fields says how many rather than listing
 * them — the changes array is still there for anyone who wants the detail.
 */
export function buildSummary(
  action: ActivityAction,
  subjectType: string,
  label: string,
  changes: FieldChange[]
): string {
  const what = [subjectType, label].filter(Boolean).join(" ");
  if (action === "CREATE") return `Added ${what}`;
  if (action === "DELETE") return `Deleted ${what}`;
  if (changes.length === 0) return `Updated ${what}`;
  if (changes.length <= 2) {
    return changes
      .map(
        (c) => `${fieldLabel(c.field)} ${readable(c.from)} → ${readable(c.to)}`
      )
      .join("; ");
  }
  return `Updated ${changes.length} fields on ${what}`;
}
