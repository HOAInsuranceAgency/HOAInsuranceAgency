import { waitsForExtraction } from "../../../../shared/leadUpload";

/**
 * When a lead's auto-reply may go out, and what it may say.
 *
 * Pure — no data client, no SES, no Bedrock — so the rule that decides whether
 * someone gets an email is testable without mocking any of them. `handler.ts`
 * does the reading, the generating and the sending.
 *
 * The whole point of this module is that a reply is never *lost*. Every branch
 * either sends or names a concrete reason to wait again, and the waiting
 * branches are all bounded by something that must eventually resolve.
 */

/** The fields the rule reads off a LeadReply row. */
export interface ReplyWindow {
  id: string;
  accountId: string;
  status?: string | null;
  dueAt: string;
  uploadCount?: number | null;
  closedAt?: string | null;
}

/** The fields the rule reads off a Document row. */
export interface DocumentState {
  name?: string | null;
  ocrStatus?: string | null;
}

/** The fields the rule reads off the Account. */
export interface AccountState {
  extractionStatus?: string | null;
}

/** OCR states that will never change again. */
const OCR_TERMINAL = new Set(["COMPLETE", "FAILED", "SKIPPED"]);
/** Extraction states that will never change again. */
const EXTRACTION_TERMINAL = new Set(["COMPLETE", "FAILED"]);

export type Decision =
  /** Send now. `withDocuments` picks which prompt the email is built from. */
  | { action: "send"; withDocuments: boolean; note?: string }
  /** Not yet. `reason` is logged, never shown to the lead. */
  | { action: "wait"; reason: string }
  /** OCR is done but nothing has asked for extraction yet. */
  | { action: "extract"; reason: string };

/**
 * What to do with one window, right now.
 *
 * Order matters. The deadline gate comes first because everything after it
 * assumes the visitor is finished; the document gates come after because a
 * closed window with documents still in OCR is a wait, not a send.
 */
export function decide(opts: {
  reply: ReplyWindow;
  documents: DocumentState[];
  account: AccountState;
  now: string;
}): Decision {
  const { reply, documents, account, now } = opts;

  if (reply.status !== "WAITING") {
    return { action: "wait", reason: `status is ${reply.status}` };
  }
  // Day-string comparison is not safe here and neither is a duration: these are
  // full ISO instants, which compare correctly as text in UTC.
  if (reply.dueAt > now) {
    return { action: "wait", reason: "deadline not reached" };
  }

  // Nothing was ever uploaded, so there is nothing to wait for. This is the
  // common path: an 8-minute silence, or a tab that closed with no files.
  if (!reply.uploadCount) {
    return { action: "send", withDocuments: false };
  }

  /**
   * Only files OCR can actually read hold the reply up.
   *
   * A spreadsheet budget is attached and useful, but Textract will never
   * produce text for it, so waiting on its `ocrStatus` would wait forever.
   */
  const extractable = documents.filter((d) => waitsForExtraction(d.name ?? ""));

  // Every uploaded file was attach-only, so there is no extraction coming.
  if (extractable.length === 0) {
    return {
      action: "send",
      withDocuments: false,
      note: "Files attached, but none were readable for extraction.",
    };
  }

  const pending = extractable.filter((d) => !OCR_TERMINAL.has(d.ocrStatus ?? "PENDING"));
  if (pending.length > 0) {
    return { action: "wait", reason: `${pending.length} document(s) still in OCR` };
  }

  // Every readable file failed OCR — a photo of a photo, an encrypted PDF.
  // There will be no text to extract from, so waiting is pointless.
  if (extractable.every((d) => d.ocrStatus === "FAILED")) {
    return {
      action: "send",
      withDocuments: false,
      note: "Uploaded documents could not be read, so the reply has no document context.",
    };
  }

  const extraction = account.extractionStatus ?? null;

  // OCR is done and nothing has kicked extraction off yet.
  if (extraction === null) {
    return { action: "extract", reason: "OCR complete, extraction not started" };
  }
  if (!EXTRACTION_TERMINAL.has(extraction)) {
    return { action: "wait", reason: `extraction is ${extraction}` };
  }

  /**
   * Extraction failed after OCR succeeded.
   *
   * "Always wait for extraction" has no answer for a permanent failure, so this
   * sends the form-only reply rather than never replying at all. A lead who
   * hears nothing because a model call errored is a bug, not a policy.
   */
  if (extraction === "FAILED") {
    return {
      action: "send",
      withDocuments: false,
      note: "Extraction failed, so the reply was sent without document context.",
    };
  }

  return { action: "send", withDocuments: true };
}
