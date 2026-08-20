/**
 * What we ask a lead to send, in one place.
 *
 * This list is the whole point of the upload portal, and it is read by three
 * things that must not disagree: the page renders a section per item, the
 * portal Lambda maps an upload onto a `DocumentCategory`, and the extraction
 * pass decides from the category whether a document is worth reading.
 *
 * Dependency-free and value-only, same rule as `agency.ts` and `leadUpload.ts`,
 * so an Astro page, a React island and a Lambda can all import it.
 *
 * ─ On `category` ─────────────────────────────────────────────────────────────
 * These strings are members of the CRM's `DocumentCategory` schema enum. They
 * are written literally here because `shared/` cannot import the Amplify schema
 * (that would drag the browser data client into every Lambda that reads this).
 * `webLeadFields.test.ts`'s neighbour `leadDocuments.test.ts` asserts every one
 * of them exists in `resource.ts`, so the coupling is checked rather than
 * trusted.
 */

export interface RequestedDocument {
  /** Stable id. Used as the dropzone's DOM id and in the upload mutation. */
  key: string;
  /** Section heading on the page. */
  label: string;
  /**
   * The one line under the heading. Written to be read by a board member who
   * has never bought commercial insurance, not by a producer.
   */
  help: string;
  /** The `DocumentCategory` an upload here is filed as. */
  category: string;
}

/**
 * Ordered the way a trustee can actually work through it: the two things most
 * of them already have to hand first, the things the management company has to
 * pull next, and the ones that need digging last. Anyone who stops partway has
 * still given us the most useful half.
 */
export const REQUESTED_DOCUMENTS: readonly RequestedDocument[] = Object.freeze([
  Object.freeze({
    key: "policies",
    label: "Current policies",
    help: "The full policy or the declaration pages for each line you carry. If you only have the binder, that is a fine start.",
    category: "PRIOR_POLICY",
  }),
  Object.freeze({
    key: "renewal-proposal",
    label: "Renewal proposal",
    help: "Whatever your current agent has sent for the coming term, if it has arrived yet.",
    category: "QUOTE_DOC",
  }),
  Object.freeze({
    key: "loss-runs",
    label: "Loss runs",
    help: "Five years for property, liability and D&O. Your carrier or current agent can produce these on request, and they usually come as one file per line.",
    category: "LOSS_RUNS",
  }),
  Object.freeze({
    key: "values",
    label: "Building schedule or statement of values",
    help: "The schedule your policy is rated on: each building, its square footage and its insured value.",
    category: "STATEMENT_OF_VALUES",
  }),
  Object.freeze({
    key: "budget",
    label: "Current association budget",
    help: "This year's operating budget, as adopted.",
    category: "BUDGET",
  }),
  Object.freeze({
    key: "governing-docs",
    label: "Governing documents",
    help: "Master deed, declaration of trust, bylaws, or whichever of those your association has. These decide where the master policy ends and a unit owner's coverage begins.",
    category: "CONDO_DOCS",
  }),
  Object.freeze({
    key: "updates",
    label: "Recent building updates",
    help: "Anything on roof, electrical, plumbing or heating work: invoices, a contractor's letter, or just the years the work was done. This is the single thing that moves property pricing most, and it is the one carriers most often have to guess at.",
    category: "PROPERTY_UPDATES",
  }),
]);

/** Lookup by the key the page and the mutation pass around. */
export function requestedDocument(key: unknown): RequestedDocument | null {
  if (typeof key !== "string") return null;
  return REQUESTED_DOCUMENTS.find((d) => d.key === key) ?? null;
}

/**
 * The category an upload against `key` is filed as, or null if the key is not
 * one we asked for.
 *
 * Null rather than a fallback to OTHER on purpose: this is a public mutation, so
 * an unrecognised key is a caller sending something the page cannot have sent,
 * and quietly filing it is how junk categories appear in the CRM.
 */
export function categoryForKey(key: unknown): string | null {
  return requestedDocument(key)?.category ?? null;
}

/**
 * How long a portal link stays live.
 *
 * Long enough that a board that meets monthly can act on it, short enough that
 * a link forwarded on and forgotten does not stay an open door onto an account
 * forever. An expired link is not a dead end: the page says to reply to the
 * email and we send a new one.
 */
export const PORTAL_TTL_DAYS = 60;

/**
 * Files a portal will take, across every section.
 *
 * Much higher than the 10 the post-submit panel allows, because that panel is
 * one opportunistic dropzone and this is a request for seven kinds of document.
 * Five years of loss runs across three lines is fifteen files before anything
 * else on the list.
 */
export const PORTAL_MAX_FILES = 60;
