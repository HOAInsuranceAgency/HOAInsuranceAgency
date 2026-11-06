/** Shared quote lifecycle classification, without a data-client dependency.
 * The table is checked against the generated schema in schemaContracts.test.ts.
 */
/** Literal table keys, checked against the schema by CRM's compile-time guard. */
export type QuoteStatus = keyof typeof QUOTE_STATUS_KIND;

/**
 * - `OPEN`   — still being worked; shows in the pipeline.
 * - `BOUND`  — closed, and reachable only by binding a quote. Never offered
 *              in a status dropdown, which is the one way it differs from
 *              the other closed statuses.
 * - `CLOSED` — closed by a human picking it (declined, lost).
 */
type QuoteStatusKind = "OPEN" | "BOUND" | "CLOSED";

/**
 * The single table. Every list below is derived from it.
 *
 * `satisfies` (not `:`) so the literal key/value types survive for the
 * mapped types below. The separate schema equality check enforces exhaustiveness.
 */
const QUOTE_STATUS_KIND = {
  DRAFT: "OPEN",
  SUBMITTED: "OPEN",
  QUOTED: "OPEN",
  PRESENTED: "OPEN",
  BOUND: "BOUND",
  DECLINED: "CLOSED",
  LOST: "CLOSED",
} as const satisfies Record<string, QuoteStatusKind>;

type StatusesOfKind<K extends QuoteStatusKind> = {
  [S in QuoteStatus]: (typeof QUOTE_STATUS_KIND)[S] extends K ? S : never;
}[QuoteStatus];

/** `"DRAFT" | "SUBMITTED" | "QUOTED" | "PRESENTED"`, derived. */
export type OpenQuoteStatus = StatusesOfKind<"OPEN">;
/** Everything that is not open — including `BOUND`. */
export type ClosedQuoteStatus = Exclude<QuoteStatus, OpenQuoteStatus>;
/** Every status a human may pick from a dropdown: all but `BOUND`. */
export type SelectableQuoteStatus = StatusesOfKind<"OPEN" | "CLOSED">;

/**
 * Safe cast: QuoteStatus is derived from these exact keys. The CRM's schema
 * equality check rejects missing or excess members relative to Amplify.
 * Declaration order matches the enum's order in the schema.
 */
const ALL = Object.keys(QUOTE_STATUS_KIND) as QuoteStatus[];

/** Is this one of the schema's quote statuses at all? */
export function isQuoteStatus(s: string | null | undefined): s is QuoteStatus {
  return s != null && Object.prototype.hasOwnProperty.call(QUOTE_STATUS_KIND, s);
}

/** Still in the pipeline. */
export function isOpenQuoteStatus(
  s: string | null | undefined
): s is OpenQuoteStatus {
  return isQuoteStatus(s) && QUOTE_STATUS_KIND[s] === "OPEN";
}

/** Done — bound, declined or lost. False for anything not a status. */
export function isClosedQuoteStatus(
  s: string | null | undefined
): s is ClosedQuoteStatus {
  return isQuoteStatus(s) && QUOTE_STATUS_KIND[s] !== "OPEN";
}

/** Offerable in a status `<select>`. */
export function isSelectableQuoteStatus(
  s: string | null | undefined
): s is SelectableQuoteStatus {
  return isQuoteStatus(s) && QUOTE_STATUS_KIND[s] !== "BOUND";
}

/** Every status the schema allows, in schema order. */
export const ALL_QUOTE_STATUSES: readonly QuoteStatus[] = Object.freeze(ALL);

/** The list this module exists for. Schema order: DRAFT → PRESENTED. */
export const OPEN_QUOTE_STATUSES: readonly OpenQuoteStatus[] = Object.freeze(
  ALL.filter(isOpenQuoteStatus)
);

/** The exact complement of {@link OPEN_QUOTE_STATUSES}. */
export const CLOSED_QUOTE_STATUSES: readonly ClosedQuoteStatus[] =
  Object.freeze(ALL.filter(isClosedQuoteStatus));

/**
 * Statuses a human may pick. This is the list `CoverageForm` used to call
 * `QUOTE_STATUSES` and `QuotesPanel` used to spell `[...OPEN_STATUSES,
 * "DECLINED", "LOST"]` — a superset of the open set, and deliberately not the
 * same list. Both now read it from here.
 */
export const SELECTABLE_QUOTE_STATUSES: readonly SelectableQuoteStatus[] =
  Object.freeze(ALL.filter(isSelectableQuoteStatus));

/**
 * The `or:` shape `client.models.Quote.list({ filter })` wants.
 *
 * Written structurally rather than as Amplify's generated
 * `ModelQuoteFilterInput`: that type is only reachable through the client
 * module, and importing it here would drag `generateClient()` back in. It is
 * assignable to the real parameter — verified against `Quote.list` — and
 * arrays are mutable and freshly built per call, because Amplify's filter
 * input is not `readonly`.
 */
export type QuoteStatusFilter = { or: { status: { eq: QuoteStatus } }[] };

/** `or:`-filter for an arbitrary set of statuses. */
export function quoteStatusFilter(
  statuses: readonly QuoteStatus[]
): QuoteStatusFilter {
  return { or: statuses.map((status) => ({ status: { eq: status } })) };
}

/**
 * Drop-in for the hand-written four-clause `or:` filter: the same list as
 * {@link OPEN_QUOTE_STATUSES}, in the shape a GraphQL list call takes.
 */
export function openQuoteStatusFilter(): QuoteStatusFilter {
  return quoteStatusFilter(OPEN_QUOTE_STATUSES);
}
