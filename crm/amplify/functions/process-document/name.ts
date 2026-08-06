/**
 * What a document is called.
 *
 * A document's `name` starts life as whatever the scanner called the file, so
 * a producer's document list is a column of `scan_0043.pdf` and
 * `IMG_2211.jpeg`. That column is also what global document search matches
 * on, which makes the default name worse than useless there.
 *
 * Two things rewrite it — the producer's rename box and the Lambda's
 * auto-namer in `autoName.ts` — and both go through {@link withExtension},
 * because they must agree on one rule: **the extension on the record always
 * matches the object in S3.** `FilePreview.canPreview` decides whether the
 * Preview button appears by reading the extension off `name`, so a name that
 * loses or changes it silently removes a button the user was using yesterday.
 *
 * This module imports nothing, and that is load-bearing rather than tidy: the
 * browser imports it for the rename box (the same direction
 * `form-filler/sanitise.ts` is imported by `lib/aiFill.ts`), and the Claude
 * call that produced the suggestion lives one file over precisely so that
 * `@anthropic-ai/sdk` — 166KB of it — stays out of the app bundle.
 */

/**
 * Long enough for "2024 Operating Budget — Willow Creek Homeowners
 * Association", short enough that the table column does not wrap.
 */
export const MAX_NAME_CHARS = 90;

/**
 * `budget.2024.pdf` → `{ stem: "budget.2024", ext: ".pdf" }`.
 *
 * A leading dot is a hidden file, not an extension (`.env` keeps its name),
 * and a trailing dot is not one either (`draft.` has nothing after it).
 */
export function splitExtension(filename: string): { stem: string; ext: string } {
  const base = filename.slice(filename.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return { stem: base, ext: "" };
  return { stem: base.slice(0, dot), ext: base.slice(dot) };
}

/**
 * Everything a name must survive before it is stored: control characters and
 * path separators (which would make the value unsafe to echo anywhere a path
 * is expected), the quotes a model sometimes wraps its answer in, and the
 * length cap.
 */
function clean(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[/\\]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^["'`\s]+/, "")
    .replace(/["'`\s.]+$/, "")
    .slice(0, MAX_NAME_CHARS)
    .trim();
}

/**
 * The name to store for `proposed`, carrying the extension of the file it
 * describes. `null` when cleaning leaves nothing usable — an empty name is
 * not a rename, it is a row that reads as a blank cell.
 *
 * `extensionSource` is the *stored object's* filename, not the current
 * display name: those diverge the moment anything renames the record, and
 * only the object's tells you what the bytes actually are.
 *
 * An extension the author typed themselves is dropped only when it already
 * matches — "Loss Runs.pdf" becomes "Loss Runs.pdf", not "Loss Runs.pdf.pdf".
 * A *different* one is kept as part of the stem ("Budget.doc" on a PDF stores
 * "Budget.doc.pdf"), because the alternative is guessing which of the two the
 * author meant and being wrong about names like "Policy v2.1".
 */
export function withExtension(
  proposed: string,
  extensionSource: string
): string | null {
  const { ext } = splitExtension(extensionSource);
  let stem = clean(proposed);
  if (ext && stem.toLowerCase().endsWith(ext.toLowerCase())) {
    stem = clean(stem.slice(0, -ext.length));
  }
  if (!stem) return null;
  return stem + ext;
}
