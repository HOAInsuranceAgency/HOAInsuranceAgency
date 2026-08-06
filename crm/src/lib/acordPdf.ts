// PDF plumbing: template fetch, the field-fill engine, and the signature
// mark. Knows nothing about any particular ACORD form — the per-form
// mappings hand it a FieldValues. Public entry point: ./acord.ts

import { PDFDocument, PDFTextField, PDFCheckBox, PDFName, PDFBool } from "pdf-lib";
import { downloadData } from "aws-amplify/storage";
import { getUrl } from "aws-amplify/storage";
import { client } from "./client";

export type FieldValues = Record<string, { candidates: string[]; value: string }>;

export interface FillResult {
  bytes: Uint8Array;
  filled: string[]; // logical fields written
  missing: string[]; // logical fields with no matching PDF field
  unsigned?: string; // why the signature isn't on the document, if it isn't
  /**
   * The filled document itself, so a second pass (W8's AI gap-fill) can write
   * into it without re-parsing the template — and so `bytes` above stays what
   * it has always been: the deterministic result, complete on its own if the
   * gap-fill is skipped or fails.
   */
  pdf: PDFDocument;
  /** Text fields still empty after the deterministic fill. */
  empty: EmptyField[];
}

/** An unanswered text field, with what the template will accept in it. */
export interface EmptyField {
  name: string;
  /** The field's `MaxLen`, when the template sets one. */
  maxLength?: number;
}

/**
 * Text fields still blank after a deterministic fill.
 *
 * Text only, and empty only: a checkbox has no value an AI should be guessing
 * at (ticking "yes, there are firewalls" is a coverage-affecting claim), and
 * a field the mapping already answered is not up for revision. That last part
 * is the mechanism, not a convention — a field that has text is simply not in
 * this list, so nothing downstream can be handed it.
 */
export function emptyTextFields(pdf: PDFDocument): EmptyField[] {
  const out: EmptyField[] = [];
  for (const field of pdf.getForm().getFields()) {
    if (!(field instanceof PDFTextField)) continue;
    try {
      if (field.getText()) continue;
      const maxLength = field.getMaxLength();
      out.push({
        name: field.getName(),
        ...(typeof maxLength === "number" && maxLength > 0 ? { maxLength } : {}),
      });
    } catch {
      // A field pdf-lib can't read is one nothing should try to write.
    }
  }
  return out;
}

/**
 * Save, falling back when pdf-lib can't rebuild the template's fonts.
 *
 * Complex ACORD templates reference fonts pdf-lib can't regenerate
 * appearances for, and that throws during save. Setting NeedAppearances hands
 * rendering to the PDF viewer instead. Deliberately NOT flattened either way
 * — the PDF stays editable for manual touch-ups.
 */
async function savePdf(pdf: PDFDocument): Promise<Uint8Array> {
  try {
    return await pdf.save();
  } catch {
    try {
      pdf.getForm().acroForm.dict.set(PDFName.of("NeedAppearances"), PDFBool.True);
    } catch {
      /* older pdf-lib internals — best effort */
    }
    return pdf.save({ updateFieldAppearances: false });
  }
}

/** Why a suggested value didn't make it onto the page. */
export type RejectReason =
  /** The deterministic pass had already answered it. */
  | "already-filled"
  /** Longer than the template's MaxLen. */
  | "too-long"
  /** No such text field, or one pdf-lib couldn't write. */
  | "no-such-field";

export interface Rejection {
  field: string;
  reason: RejectReason;
}

/**
 * Write AI-suggested values into an already-filled document.
 *
 * The second gate on W8's gap-fill, and the one that has the PDF in front of
 * it: the Lambda drops placeholders and unrequested names, and this drops
 * anything that doesn't fit the field or would overwrite an answer the
 * mapping gave. A value rejected here is reported with its reason, not
 * swallowed — a producer who is shown a value has to be able to find it on
 * the page, and one who is told a value was dropped should be told why.
 */
export async function applySuggestions(
  pdf: PDFDocument,
  values: { field: string; value: string }[]
): Promise<{ bytes: Uint8Array; applied: string[]; rejected: Rejection[] }> {
  const form = pdf.getForm();
  const applied: string[] = [];
  const rejected: Rejection[] = [];

  for (const { field: name, value } of values) {
    try {
      const field = form.getField(name);
      if (!(field instanceof PDFTextField)) {
        rejected.push({ field: name, reason: "no-such-field" });
        continue;
      }
      // Re-checked rather than trusted: the list of blanks was taken before
      // the round trip, and a deterministic value must never lose to a
      // suggested one.
      if (field.getText()) {
        rejected.push({ field: name, reason: "already-filled" });
        continue;
      }
      const max = field.getMaxLength();
      if (typeof max === "number" && max > 0 && value.length > max) {
        // pdf-lib would throw here too, and the catch below would call it a
        // missing field. Checking first is what makes the producer's note say
        // "too long for the box" instead of "that field doesn't exist" —
        // truncating is not on the table either way, because half a legal
        // name on a carrier form reads as deliberate.
        rejected.push({ field: name, reason: "too-long" });
        continue;
      }
      field.setText(value);
      applied.push(name);
    } catch {
      rejected.push({ field: name, reason: "no-such-field" });
    }
  }

  return { bytes: await savePdf(pdf), applied, rejected };
}

/**
 * Draw a signature image into a form field's rectangle.
 *
 * ACORD signature slots are plain text fields, so there's nothing to "sign" —
 * we locate the field's widget, then stamp the PNG onto that page at those
 * coordinates and remove the field so it can't be typed over afterwards.
 * Aspect ratio is preserved and the image is inset slightly so it sits on the
 * ruled line rather than across it.
 */
async function stampSignature(
  pdf: PDFDocument,
  fieldName: string,
  pngBytes: Uint8Array
): Promise<boolean> {
  const form = pdf.getForm();
  let field;
  try {
    field = form.getField(fieldName);
  } catch {
    return false;
  }
  const widget = field.acroField.getWidgets()[0];
  if (!widget) return false;

  const rect = widget.getRectangle();
  const pageRef = widget.P();
  const page =
    pdf.getPages().find((p) => p.ref === pageRef) ?? pdf.getPages()[0];

  const png = await pdf.embedPng(pngBytes);
  const pad = 1;
  const maxW = rect.width - pad * 2;
  const maxH = rect.height - pad * 2;
  const scale = Math.min(maxW / png.width, maxH / png.height);
  const w = png.width * scale;
  const h = png.height * scale;

  page.drawImage(png, {
    x: rect.x + pad,
    y: rect.y + pad,
    width: w,
    height: h,
  });

  // The slot is signed — drop the input so nothing can overwrite the mark.
  try {
    form.removeField(field);
  } catch {
    /* older pdf-lib: leaving the field is harmless */
  }
  return true;
}

/** Signature slots we know how to fill, in preference order. */
const SIGNATURE_FIELDS = [
  "Producer_AuthorizedRepresentative_Signature_A",
  "Producer_Signature_A",
  "AuthorizedRepresentative_Signature_A",
];

const SIGNATURE_NAME_FIELDS = [
  "Producer_AuthorizedRepresentative_FullName_A",
  "Producer_ContactPerson_FullName_A",
];

export interface SignatureInfo {
  /** S3 key under signatures/. Empty when `error` says why there isn't one. */
  key: string;
  /** Printed name that accompanies the mark. */
  name: string;
  /**
   * Set when the lookup failed, as opposed to the signer simply having no
   * signature on file. The form still generates — unsigned — and this is
   * reported back through FillResult.unsigned.
   */
  error?: string;
}

/**
 * Read the signer's current signature straight from the record.
 *
 * The app loads the user's profile once at sign-in, so a signature added
 * later in the same session isn't on that object — trusting the prop meant
 * generation silently stamped nothing. One read per generation is cheap and
 * can't go stale.
 */
export async function signatureFor(
  profileId: string
): Promise<SignatureInfo | null> {
  try {
    const { data } = await client.models.UserProfile.get({ id: profileId });
    if (!data?.signatureKey) return null;
    return {
      key: data.signatureKey,
      name: `${data.firstName} ${data.lastName}`.trim(),
    };
  } catch (err) {
    // Not the same as "no signature on file" — say so, or the form comes
    // out unsigned and nobody finds out until the carrier does.
    return {
      key: "",
      name: "",
      error: err instanceof Error ? err.message : "signature lookup failed",
    };
  }
}

/** Fetch a stored signature PNG. Throws if the object can't be read. */
async function loadSignature(key: string): Promise<Uint8Array> {
  const { body } = await downloadData({ path: key }).result;
  const blob = await body.blob();
  return new Uint8Array(await blob.arrayBuffer());
}

async function fetchTemplate(path: string): Promise<ArrayBuffer> {
  const { url } = await getUrl({ path });
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Template fetch failed (${res.status})`);
  return res.arrayBuffer();
}

/** List every form field in a template PDF — the Settings-page inspector. */
export async function listTemplateFields(path: string): Promise<string[]> {
  const pdf = await PDFDocument.load(await fetchTemplate(path), {
    ignoreEncryption: true,
  });
  // instanceof, not constructor.name — minified builds mangle class names.
  const typeOf = (f: unknown) =>
    f instanceof PDFTextField ? "text" : f instanceof PDFCheckBox ? "checkbox" : "other";
  return pdf
    .getForm()
    .getFields()
    .map((f) => `${f.getName()}  (${typeOf(f)})`);
}

/** Shared fill core: first matching candidate wins; misses are reported. */
export async function fillTemplate(
  path: string,
  values: FieldValues,
  signature?: SignatureInfo | null
): Promise<FillResult> {
  const pdf = await PDFDocument.load(await fetchTemplate(path), {
    ignoreEncryption: true,
  });
  const form = pdf.getForm();
  const fieldNames = new Set(form.getFields().map((f) => f.getName()));

  const filled: string[] = [];
  const missing: string[] = [];

  for (const [logical, { candidates, value }] of Object.entries(values)) {
    if (!value) continue;
    const name = candidates.find((c) => fieldNames.has(c));
    if (!name) {
      missing.push(logical);
      continue;
    }
    // Guard each field: a single malformed field on a large ACORD form
    // should never abort the whole generation.
    try {
      const field = form.getField(name);
      if (field instanceof PDFTextField) {
        field.setText(value);
        filled.push(logical);
      } else if (field instanceof PDFCheckBox) {
        field.check();
        filled.push(logical);
      }
    } catch {
      missing.push(logical);
    }
  }

  // ── Signature ──
  // Stamped after the text fields so the printed name is already in place.
  // An unsigned form is a document-integrity problem, so every way the mark
  // can go missing is reported back instead of swallowed.
  let unsigned = signature?.error;
  if (signature?.key) {
    for (const nameField of SIGNATURE_NAME_FIELDS) {
      if (!fieldNames.has(nameField)) continue;
      try {
        const f = form.getField(nameField);
        if (f instanceof PDFTextField && !f.getText()) f.setText(signature.name);
      } catch {
        /* non-fatal */
      }
      break;
    }
    try {
      const png = await loadSignature(signature.key);
      let stamped = false;
      for (const sigField of SIGNATURE_FIELDS) {
        if (!fieldNames.has(sigField)) continue;
        stamped = await stampSignature(pdf, sigField, png);
        break;
      }
      if (stamped) filled.push("signature");
      else unsigned = "this template has no signature field the mapping knows";
    } catch (err) {
      unsigned =
        err instanceof Error ? err.message : "the signature image wouldn't load";
    }
  }

  // Read before saving: `savePdf` may set NeedAppearances, and the blanks are
  // a property of the fields either way.
  const empty = emptyTextFields(pdf);
  return { bytes: await savePdf(pdf), filled, missing, unsigned, pdf, empty };
}
