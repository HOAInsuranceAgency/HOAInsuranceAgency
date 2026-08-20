/**
 * Turning a stored extraction result into prompt context. Pure, so the one
 * thing that decides whether the reply knows what a lead's documents say is
 * testable without a data client.
 */

/**
 * Keys in `aiExtraction` that describe the extraction run, not the association.
 *
 * `extract-lead` spreads the model's fields and then adds its own bookkeeping
 * alongside them, so the stored object is a mix of the two. Feeding the
 * bookkeeping to the reply prompt would have it telling a board member their
 * document shows a "Documentcount: 1".
 */
const RUN_METADATA = new Set(["extractedAt", "documentCount", "usage"]);

/**
 * Read `Account.aiExtraction` into `{ field: value }` for the reply prompt.
 *
 * ## Why this parses
 *
 * `aiExtraction` is `a.json()`, which is AWSJSON on the wire, and AWSJSON is a
 * JSON *string* — the Amplify data client does not parse it for you. On top of
 * that, `extract-lead` stores the result with `JSON.stringify`, so the value
 * arriving here can be a string wrapping a string. `ExtractionPanel` in the app
 * has always handled both depths; this did not, and a `typeof raw !== "object"`
 * guard turned every successful extraction into "no documents could be read".
 *
 * Values only: a model shown a confidence score starts hedging in prose, and
 * evidence strings are long enough to crowd out the instructions.
 */
export function flattenExtraction(raw: unknown): Record<string, string> | null {
  let v: unknown = raw;
  try {
    // Twice, for the same reason `parseExtraction` does: AWSJSON encoding on
    // top of the handler's own `JSON.stringify`.
    if (typeof v === "string") v = JSON.parse(v);
    if (typeof v === "string") v = JSON.parse(v);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;

  const out: Record<string, string> = {};
  for (const [key, cell] of Object.entries(v as Record<string, unknown>)) {
    if (RUN_METADATA.has(key)) continue;
    const value =
      cell && typeof cell === "object" && "value" in cell
        ? (cell as { value?: unknown }).value
        : cell;
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
    else if (typeof value === "number") out[key] = String(value);
  }
  // `contacts`, `buildings` and `losses` are arrays and fall out here, which is
  // right: a list of buildings is for the reviewer, not for a first email.
  return Object.keys(out).length ? out : null;
}
