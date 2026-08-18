/**
 * S3 key hygiene, with no dependencies.
 *
 * Split out of `storage.ts` so a Lambda can use it. That module imports the
 * browser data client and `aws-amplify/storage`; pulling either into a handler
 * bundle drags a browser runtime into a function that has no DOM — the same
 * constraint `lead-intake` documents about `enums.ts`. This file imports
 * nothing, so both sides can share one definition instead of keeping two.
 */

/** Control characters, which neither an S3 key nor a header may contain. */
export const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

/**
 * Make one user-supplied value safe to drop into a key. A filename containing
 * a slash would otherwise add a level to the key, which breaks the OCR
 * trigger's `documents/{type}/{entity}/{documentId}/{file}` parse — and any
 * surviving `..` would be rejected by `assertGrantedPath`, turning a merely
 * odd filename into a failed upload.
 */
export function safeSegment(value: string): string {
  const cleaned = value
    .replace(CONTROL_CHARS, "")
    .replace(/[/\\]+/g, "_")
    // Flatten dot runs wherever they landed, not just at the front: the slash
    // collapse above moves a leading "../" into the middle of the segment.
    .replace(/\.{2,}/g, ".")
    .replace(/^[._]+/, "")
    .trim();
  return cleaned || "file";
}
