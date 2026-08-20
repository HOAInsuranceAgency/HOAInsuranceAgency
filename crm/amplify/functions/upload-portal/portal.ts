import {
  PORTAL_MAX_FILES,
  REQUESTED_DOCUMENTS,
  categoryForKey,
} from "../../../../shared/leadDocuments";

/**
 * The rules a public upload link is held to. Pure — no data client, no S3 — so
 * the question "may this token do this" is testable without mocking either.
 *
 * `handler.ts` does the reading, presigning and writing.
 */

/** The fields these rules read off an UploadPortal row. */
export interface PortalState {
  expiresAt: string;
  revokedAt?: string | null;
  uploadCount?: number | null;
}

export type PortalRefusal = "unknown" | "expired" | "revoked" | "full";

/**
 * What a caller is told, per refusal.
 *
 * "Unknown" and "revoked" say the same thing on purpose. A caller probing tokens
 * must not be able to tell a token that never existed from one that did, because
 * the second answer confirms an account exists and is worth guessing at.
 *
 * Expiry is the exception and says so plainly, because it is the one a real
 * board member will hit — a link found in a two-month-old email — and telling
 * them "no such link" when the answer is "ask for a fresh one" loses the
 * documents we were asking for.
 */
export const PORTAL_REFUSAL_MESSAGE: Record<PortalRefusal, string> = {
  unknown: "That upload link is no longer active.",
  revoked: "That upload link is no longer active.",
  expired:
    "This upload link has expired. Reply to the email it came from and we'll send you a new one.",
  full: `This link has reached its limit of ${PORTAL_MAX_FILES} files. Reply to the email it came from and we'll take the rest by email.`,
};

/**
 * Whether this portal may still take a file.
 *
 * Order matters: revoked beats expired, so a link a producer killed reports as
 * dead rather than telling the holder to ask for a new one.
 */
export function refusalFor(
  portal: PortalState | null | undefined,
  now: string
): PortalRefusal | null {
  if (!portal) return "unknown";
  if (portal.revokedAt) return "revoked";
  // Full ISO instants, which compare correctly as text in UTC.
  if (portal.expiresAt <= now) return "expired";
  if ((portal.uploadCount ?? 0) >= PORTAL_MAX_FILES) return "full";
  return null;
}

/**
 * The shortest token we would ever have minted.
 *
 * 22 characters is 16 bytes of base64url, which is what `lead-reply` mints now.
 * The floor was 32 when tokens were two concatenated UUIDs; lowering it keeps
 * those older links working, since every one of them is longer than this.
 */
const MIN_TOKEN_LENGTH = 22;

/**
 * A token worth spending a query on.
 *
 * The length floor is not security — the entropy is — it is a cheap way to
 * refuse the empty string and other obvious junk before it becomes a read.
 */
export function looksLikeToken(token: unknown): token is string {
  return typeof token === "string" && token.length >= MIN_TOKEN_LENGTH;
}

/** One checklist section, as the page renders it. */
export interface ChecklistSection {
  key: string;
  label: string;
  help: string;
  /** How many files have arrived against this section. */
  received: number;
}

/**
 * The checklist, with counts filled in from the account's documents.
 *
 * Counted by category rather than by section key, because the category is what
 * is actually stored on a Document. Two sections never share a category, so the
 * mapping is unambiguous — `leadDocuments.test.ts` asserts that.
 *
 * Documents that arrived some other way (a staff upload, the post-submit panel's
 * uncategorised files) land on no section and are not counted. That is correct
 * for a checklist: it answers "have you sent me the loss runs", not "how many
 * files does this account have".
 */
export function buildChecklist(
  documents: readonly { category?: string | null }[]
): ChecklistSection[] {
  const counts = new Map<string, number>();
  for (const doc of documents) {
    if (!doc.category) continue;
    counts.set(doc.category, (counts.get(doc.category) ?? 0) + 1);
  }
  return REQUESTED_DOCUMENTS.map((d) => ({
    key: d.key,
    label: d.label,
    help: d.help,
    received: counts.get(d.category) ?? 0,
  }));
}

/**
 * The category an upload against this section is filed as, or null.
 *
 * A thin pass-through, kept so `handler.ts` imports its guards from one place
 * and so the null-means-refuse rule is stated once. Re-exported rather than
 * re-implemented: `shared/leadDocuments.ts` owns the mapping.
 */
export function categoryForUpload(documentKey: unknown): string | null {
  return categoryForKey(documentKey);
}
