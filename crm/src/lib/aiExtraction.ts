/**
 * Reading `Account.aiExtraction`, in one place.
 *
 * ## The trap this exists to hold
 *
 * `aiExtraction` is declared `a.json()`, which is AWSJSON on the wire, and
 * AWSJSON is a JSON *string* — the Amplify data client does not parse it. On top
 * of that, `extract-lead` stores its result with its own `JSON.stringify`, so
 * the value arriving at a reader can be a string wrapping a string.
 *
 * A reader that checks `typeof raw === "object"` and gives up sees nothing, ever.
 * That shipped: every website lead who uploaded a readable document got an email
 * apologising for not being able to read it, because `flattenExtraction` opened
 * with exactly that guard. `ExtractionPanel` had always parsed twice; nothing
 * connected the two, so the knowledge lived in one reader and not the other.
 *
 * Dependency-free, like `pagination.ts` and `storageKeys.ts`, so a Lambda can
 * import it without dragging the browser data client into its bundle.
 */

/**
 * Parse a stored AWSJSON value, however many times it was stringified.
 *
 * Returns null for anything that is not an object at the end of it, which
 * includes `null`, `""`, malformed JSON, and a JSON scalar. Callers treat null
 * as "nothing was extracted", which is the honest reading in every one of those
 * cases.
 */
export function parseStoredJson(raw: unknown): Record<string, unknown> | null {
  let v: unknown = raw;
  try {
    // Twice: AWSJSON encoding on top of the writer's own `JSON.stringify`.
    if (typeof v === "string") v = JSON.parse(v);
    if (typeof v === "string") v = JSON.parse(v);
  } catch {
    return null;
  }
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * When the stored extraction was produced, as an ISO instant, or null.
 *
 * This is what answers "does the extraction on this account already cover the
 * documents that just arrived" — compare it against the portal's `lastUploadAt`.
 * `extract-lead` writes it alongside the extracted fields on every run.
 *
 * A malformed or missing value reads as null, which callers treat as "no, run
 * extraction again". Re-running costs a model call; skipping wrongly means the
 * documents someone just sent are never read, so the safe direction is to run.
 */
export function extractedAt(raw: unknown): string | null {
  const parsed = parseStoredJson(raw);
  const value = parsed?.extractedAt;
  return typeof value === "string" && value.trim() ? value : null;
}
