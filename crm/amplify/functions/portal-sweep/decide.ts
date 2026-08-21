/**
 * When to tell the team that a lead has sent documents, and what to say first.
 *
 * Pure — no data client, no SES, no Lambda invoke — so the rule that decides
 * whether anyone hears about an upload is testable without mocking any of them.
 * `handler.ts` does the reading, extracting and sending.
 *
 * Same shape as `lead-reply/decide.ts`, and for the same reason: every branch
 * either acts or names a concrete reason to wait again, and every waiting branch
 * is bounded by something that must eventually resolve. An upload that is never
 * mentioned to anyone is the failure this whole sweep exists to prevent, so it
 * must not be reachable.
 */

/**
 * How long a portal has to be quiet before the team is told.
 *
 * The point of waiting at all is bucketing: a trustee sending five years of loss
 * runs produces five uploads over a couple of minutes, and five emails about it
 * would be worse than none. Ten minutes is long enough to gather one sitting and
 * short enough that whoever gets it can still ring back while the lead is at
 * their desk, which is the entire value of hearing about it at all.
 */
export const QUIET_MINUTES = 10;

/**
 * How long extraction may be in flight before we stop waiting for it.
 *
 * `extract-lead` marks an account PENDING and self-invokes. If that invoke is
 * lost, or the worker is killed by its own timeout mid-run, the status stays
 * non-terminal forever — and a wait with no bound is a notification that never
 * arrives, which is the exact failure this whole sweep exists to prevent.
 *
 * Longer than the OCR bound because extraction happens after it, and generous
 * because a wrongly-early send loses the document context while a late one only
 * costs time.
 */
export const EXTRACTION_PATIENCE_MINUTES = 90;

/**
 * How long a document may sit in OCR before we stop waiting for it.
 *
 * Textract usually finishes in under a minute. This is not a timeout for the
 * normal case, it is the bound that stops one wedged document from suppressing
 * the notification for every other file in the same batch, forever. Past this,
 * the email goes with whatever was readable.
 */
export const OCR_PATIENCE_MINUTES = 45;

/** The fields the rule reads off an UploadPortal row. */
export interface PortalRow {
  id: string;
  accountId: string;
  lastUploadAt?: string | null;
  notifiedUpTo?: string | null;
}

/** The fields the rule reads off a Document row. */
export interface DocumentRow {
  ocrStatus?: string | null;
  category?: string | null;
  createdAt?: string | null;
}

/** The fields the rule reads off the Account. */
export interface AccountRow {
  extractionStatus?: string | null;
  /** `extractedAt` off the stored result — see lib/aiExtraction.ts. */
  extractedAt?: string | null;
}

/** OCR states that will never change again. */
const OCR_TERMINAL = new Set(["COMPLETE", "FAILED", "SKIPPED"]);
/** Extraction states that will never change again. */
const EXTRACTION_TERMINAL = new Set(["COMPLETE", "FAILED"]);

export type SweepDecision =
  /**
   * Send the email. `upTo` is written back to `notifiedUpTo` afterwards, and is
   * the `lastUploadAt` this decision was made against rather than "now" — an
   * upload that lands while the email is being built must not be swallowed by
   * the write that marks this batch done.
   */
  | { action: "notify"; upTo: string; since: string | null }
  /** Extraction has not covered these documents yet. */
  | { action: "extract"; reason: string }
  /** Not yet. `reason` is logged, never sent anywhere. */
  | { action: "wait"; reason: string };

const minutesBetween = (from: string, to: string) =>
  (Date.parse(to) - Date.parse(from)) / 60_000;

/**
 * What to do with one portal, right now.
 *
 * Order matters. "Already told them" comes before the quiet check so a settled
 * portal costs one comparison per tick rather than a date parse, and the OCR and
 * extraction gates come last because both assume the visitor has finished.
 */
export function decideSweep(opts: {
  portal: PortalRow;
  documents: DocumentRow[];
  account: AccountRow;
  now: string;
  isExtractable: (category: string | null | undefined) => boolean;
}): SweepDecision {
  const { portal, documents, account, now, isExtractable } = opts;

  if (!portal.lastUploadAt) {
    return { action: "wait", reason: "nothing has been uploaded" };
  }
  // Full ISO instants, which compare correctly as text in UTC.
  if (portal.notifiedUpTo && portal.notifiedUpTo >= portal.lastUploadAt) {
    return { action: "wait", reason: "already notified for this batch" };
  }

  const quietFor = minutesBetween(portal.lastUploadAt, now);
  if (Number.isNaN(quietFor)) {
    // An unparseable timestamp would otherwise wait forever. Send, and let a
    // human see the batch; a spurious email beats a silent one.
    return { action: "notify", upTo: portal.lastUploadAt, since: portal.notifiedUpTo ?? null };
  }
  if (quietFor < QUIET_MINUTES) {
    return { action: "wait", reason: `still uploading (${Math.round(quietFor)}m quiet)` };
  }

  /** Only what arrived since the last time anyone was told. */
  const fresh = documents.filter(
    (d) => !portal.notifiedUpTo || (d.createdAt ?? "") > portal.notifiedUpTo
  );

  /**
   * Wait for OCR, but not indefinitely.
   *
   * Only files whose category extraction actually reads hold this up. A budget
   * or a master deed is attached and useful and will never be fed to a model, so
   * waiting on its OCR would delay the email for nothing.
   */
  const pending = fresh.filter(
    (d) => isExtractable(d.category) && !OCR_TERMINAL.has(d.ocrStatus ?? "PENDING")
  );
  if (pending.length > 0 && quietFor < OCR_PATIENCE_MINUTES) {
    return {
      action: "wait",
      reason: `${pending.length} document(s) still in OCR`,
    };
  }

  const readable = fresh.filter(
    (d) => isExtractable(d.category) && d.ocrStatus === "COMPLETE"
  );

  /**
   * Past this, extraction is neither waited for nor started again.
   *
   * Both matter. Only skipping the *wait* would fall through to the coverage
   * check below, find the documents uncovered, and return `extract` on every
   * tick forever — a loop rather than a bound. Past the bound the answer is
   * always notify, with whatever was extracted before.
   */
  const gaveUpOnExtraction = quietFor >= EXTRACTION_PATIENCE_MINUTES;

  if (readable.length > 0 && !gaveUpOnExtraction) {
    const status = account.extractionStatus ?? null;
    if (status && !EXTRACTION_TERMINAL.has(status)) {
      return { action: "wait", reason: `extraction is ${status}` };
    }
    /**
     * Has the stored extraction already read these documents?
     *
     * Compared against `lastUploadAt`, not against the run's status: a COMPLETE
     * extraction from the original auto-reply says nothing about files uploaded
     * three weeks later. A missing or unreadable `extractedAt` reads as "no",
     * which costs a model call and never costs a document going unread.
     */
    const covered =
      account.extractedAt !== null &&
      account.extractedAt !== undefined &&
      account.extractedAt >= portal.lastUploadAt;
    if (!covered) {
      return {
        action: "extract",
        reason: `${readable.length} readable document(s) newer than the last extraction`,
      };
    }
  }

  return {
    action: "notify",
    upTo: portal.lastUploadAt,
    since: portal.notifiedUpTo ?? null,
  };
}
