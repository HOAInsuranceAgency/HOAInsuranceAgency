import type { PDFDocument } from "pdf-lib";
import { client } from "./client";
import { applySuggestions, type EmptyField } from "./acordPdf";
// The Lambda's own cap, imported rather than restated. `sanitise.ts` imports
// nothing, so it costs the browser bundle a number and no dependency — the
// same arrangement `ActivityTab` has with the stream handler's `diff.ts`.
import { MAX_FIELDS } from "../../amplify/functions/form-filler/sanitise";

/**
 * W8's AI gap-fill, from the browser's side.
 *
 * The deterministic pass has already run and the document is in hand. This
 * asks the `suggestFormFields` Lambda what the account data says about the
 * fields that came out blank, writes the survivors into the same
 * `PDFDocument`, and hands back both new bytes and the list the producer has
 * to read before the file is stored.
 *
 * Every failure arm returns the original bytes. A model outage, a timeout, a
 * malformed response — none of them may cost the agency a correctly filled
 * deterministic form, so nothing here throws.
 */

export interface AiFilledField {
  field: string;
  value: string;
  /** The model's one-line justification, shown beside the value. */
  why: string;
}

export interface AiFillResult {
  /** The document with the accepted values in it, or the input unchanged. */
  bytes: Uint8Array;
  /** What went onto the page, for the review list. */
  applied: AiFilledField[];
  /**
   * Why the gap-fill did less than it could have. Not an error — the form is
   * complete as far as the mapping goes either way — but the producer is told
   * rather than left to assume the blanks were considered.
   */
  note?: string;
}


interface SuggestResponse {
  ok?: boolean;
  values?: { field?: unknown; value?: unknown; why?: unknown }[];
  skipped?: number;
  error?: string;
}

export async function aiFillGaps(
  pdf: PDFDocument,
  bytes: Uint8Array,
  empty: EmptyField[],
  accountId: string,
  formKey: string
): Promise<AiFillResult> {
  if (!empty.length) return { bytes, applied: [] };

  const asked = empty.slice(0, MAX_FIELDS);
  const capped = empty.length - asked.length;

  let payload: SuggestResponse;
  try {
    const { data, errors } = await client.mutations.suggestFormFields({
      accountId,
      formKey,
      fieldNames: asked.map((f) => f.name),
    });
    if (errors?.length) throw new Error(errors[0].message);
    payload =
      typeof data === "string" ? JSON.parse(data) : ((data ?? {}) as SuggestResponse);
  } catch (err) {
    return {
      bytes,
      applied: [],
      note: `AI gap-fill unavailable (${
        err instanceof Error ? err.message : "unknown error"
      }) — the form has everything the mapping fills and nothing more.`,
    };
  }

  if (payload.ok === false) {
    return {
      bytes,
      applied: [],
      note: `AI gap-fill failed (${payload.error ?? "unknown error"}) — the form has everything the mapping fills and nothing more.`,
    };
  }

  const suggestions = (payload.values ?? [])
    .map((v) => ({
      field: typeof v?.field === "string" ? v.field : "",
      value: typeof v?.value === "string" ? v.value : "",
      why: typeof v?.why === "string" ? v.why : "",
    }))
    .filter((v) => v.field && v.value);

  if (!suggestions.length) {
    return {
      bytes,
      applied: [],
      note: capped
        ? `The AI answered none of the blanks, and ${capped} more were not offered to it — fill those by hand.`
        : undefined,
    };
  }

  const {
    bytes: newBytes,
    applied,
    rejected,
  } = await applySuggestions(pdf, suggestions);

  const accepted = new Set(applied);
  const count = (reason: string) =>
    rejected.filter((r) => r.reason === reason).length;
  // A value shown and then silently dropped would be worse than one never
  // suggested: the producer would go looking for it on the page. Say which
  // fields and why, so "too long for the box" isn't confused with "the
  // mapping had already answered that".
  const discarded = [
    count("too-long") && `${count("too-long")} too long for the field`,
    count("already-filled") && `${count("already-filled")} already filled`,
    count("no-such-field") && `${count("no-such-field")} naming no field on this template`,
  ].filter(Boolean);

  const notes = [
    capped
      ? `${capped} blank field${capped === 1 ? " was" : "s were"} not offered to the AI — fill those by hand.`
      : "",
    discarded.length
      ? `${rejected.length} suggested value${rejected.length === 1 ? " was" : "s were"} discarded: ${discarded.join(", ")}.`
      : "",
  ].filter(Boolean);

  return {
    bytes: newBytes,
    applied: suggestions.filter((s) => accepted.has(s.field)),
    note: notes.length ? notes.join(" ") : undefined,
  };
}
