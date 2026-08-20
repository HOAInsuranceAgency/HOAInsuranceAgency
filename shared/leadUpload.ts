/**
 * The rules for a website lead's document upload, in one place.
 *
 * Both apps read this: the browser to decide what to offer and reject before a
 * byte leaves the visitor's machine, and the intake Lambda to enforce it — a
 * limit that lives only in the form is not a limit, since the mutation is
 * public. Same reason `agency.ts` and `accountType.ts` live here.
 */

/** How long a lead who uploads nothing waits before the reply goes out. */
export const NO_UPLOAD_WINDOW_MINUTES = 8;

/**
 * How long after the last upload the window stays open.
 *
 * Deliberately no ceiling on top of this: someone uploading a file every seven
 * minutes holds the window open indefinitely. That is the specified behaviour —
 * a person actively sending documents should not have their reply cut off
 * mid-stream — and the case is vanishingly rare.
 */
export const IDLE_AFTER_UPLOAD_MINUTES = 8;

/** Per file. Textract's own synchronous limit is lower, but async takes more. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Enough for a policy packet, a budget and a set of condo docs. */
export const MAX_FILES = 10;

/**
 * Extensions Textract can actually read, so uploading one buys extraction.
 *
 * Kept as extensions rather than MIME types because that is what survives the
 * round trip: browsers disagree about the type they report for a PDF, and a
 * file dragged from a phone often arrives as `application/octet-stream`.
 */
export const EXTRACTABLE_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "tif", "tiff"] as const;

/**
 * Accepted, attached to the lead, but never queued for extraction.
 *
 * A budget as a spreadsheet is useful to a producer even though no OCR will
 * read it, so refusing it would lose real information to protect a pipeline
 * that was never going to run on it. What matters is that these do not make
 * the reply wait — see `waitsForExtraction`.
 */
export const ATTACH_ONLY_EXTENSIONS = ["xls", "xlsx", "csv", "doc", "docx"] as const;

/** For the file input's `accept`, so the picker filters before a person does. */
export const UPLOAD_ACCEPT = [...EXTRACTABLE_EXTENSIONS, ...ATTACH_ONLY_EXTENSIONS]
  .map((e) => `.${e}`)
  .join(",");

export const extensionOf = (filename: string): string =>
  (filename.split(".").pop() ?? "").toLowerCase();

/** True when OCR and extraction will run on this file, so the reply waits. */
export function waitsForExtraction(filename: string): boolean {
  return (EXTRACTABLE_EXTENSIONS as readonly string[]).includes(extensionOf(filename));
}

export type UploadRejection = "type" | "size" | "count" | "name";

/**
 * Why this file cannot be uploaded, or null if it can.
 *
 * Ordered cheapest-first so the message names the most basic problem: a
 * visitor who picked a 40MB `.mov` hears about the format, not the size.
 */
export function rejectUpload(opts: {
  filename: string;
  sizeBytes?: number;
  alreadyUploaded: number;
}): UploadRejection | null {
  const name = (opts.filename ?? "").trim();
  if (!name || name.length > 200) return "name";
  const ext = extensionOf(name);
  const allowed = [
    ...(EXTRACTABLE_EXTENSIONS as readonly string[]),
    ...(ATTACH_ONLY_EXTENSIONS as readonly string[]),
  ];
  if (!allowed.includes(ext)) return "type";
  if (typeof opts.sizeBytes === "number" && opts.sizeBytes > MAX_FILE_BYTES) return "size";
  if (opts.alreadyUploaded >= MAX_FILES) return "count";
  return null;
}

/** What the visitor is told. The server sends the same strings back. */
export const REJECTION_MESSAGE: Record<UploadRejection, string> = {
  type: "That file type isn't supported. Send a PDF, an image, or a spreadsheet.",
  size: `That file is over ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB. Send a smaller copy, or email it to us.`,
  count: `You can attach up to ${MAX_FILES} files here. Email any others and we'll add them.`,
  name: "That filename isn't usable. Rename the file and try again.",
};
