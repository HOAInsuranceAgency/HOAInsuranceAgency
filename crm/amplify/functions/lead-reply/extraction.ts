import { parseStoredJson } from "../../../src/lib/aiExtraction";

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
 * The double-parse this needs lives in `lib/aiExtraction.ts` — see the note
 * there for why, and for what it cost when this function did not do it.
 *
 * Values only: a model shown a confidence score starts hedging in prose, and
 * evidence strings are long enough to crowd out the instructions.
 */
export function flattenExtraction(raw: unknown): Record<string, string> | null {
  const v = parseStoredJson(raw);
  if (!v) return null;

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
