/**
 * Which agency mailbox a function's outbound email uses, per branch.
 *
 * Staging deploys are real AWS accounts sending real email. Without this, a test
 * lead on staging puts a From of sales@ in front of a visitor and drops a BCC in
 * the queue the team works from, and the weekday digest and licence ladder mail
 * the live inbox every morning from an environment nobody is reading.
 *
 * ── Why the addresses are literals here ──
 * `backend.ts` is loaded by the CDK assembly builder with a TS loader scoped to
 * `amplify/`, so anything it imports cannot reach outside that directory —
 * `shared/agency.ts` comes back with no exports from there. That constraint is
 * why these are spelled out rather than read from `AGENCY`, and why
 * `leadReply.test.ts` asserts they still match `shared/agency.ts`: a test can
 * import both, so the duplication cannot drift unnoticed.
 *
 * Sits beside `model.ts` because, like the model id, it is configuration two
 * different layers need to agree on.
 */

/**
 * Which conversation the mail belongs to. The production address differs: a
 * lead hears from sales, whereas a digest or a licence deadline is internal and
 * belongs in the general inbox.
 */
export type MailboxKind = "lead" | "internal" | "accounting" | "owner";

/** Sales. Outbound to a prospect, and the reply-to they will use. */
export const PRODUCTION_LEAD_MAILBOX = "sales@protectmyhoa.com";

/** The agency's general inbox. Internal reports and deadlines. */
export const PRODUCTION_INTERNAL_MAILBOX = "insurance@protectmyhoa.com";

/**
 * Corporate finance, who reconcile the trust account.
 *
 * A different company's domain, not the agency's: money collected on an
 * invoice lands in trust and has to be divided between what is owed onward to
 * the carrier and what the agency has actually earned. The people who do that
 * are not the people who read insurance@.
 */
export const PRODUCTION_ACCOUNTING_MAILBOX = "corporateaccounting@getgim.com";

/**
 * The principal's own mailbox.
 *
 * One person, not a shared inbox, and that is the whole point: `internal` is
 * `insurance@`, which the entire team works out of. The daily operations
 * rollup is written for the agency's owner and names who moved what, so
 * delivering it to the shared queue would change what it is.
 *
 * Only ever a recipient, never a From — the rollup sends from the same
 * no-reply identity as every other outbound mail.
 */
export const PRODUCTION_OWNER_MAILBOX = "jake@protectmyhoa.com";

/**
 * Everywhere that is not production. A plus-address on the same SES-verified
 * domain, so DKIM still applies and the suffix survives to the mailbox and can
 * be filtered.
 */
export const TEST_MAILBOX = "jake+testing@protectmyhoa.com";

/**
 * Where remittance mail goes off production.
 *
 * A real mailbox rather than `TEST_MAILBOX`, because this is the one report
 * that has to be *read* during testing to be checked — a split that is wrong
 * is not visible from the CRM, only from the email — and a plus-addressed box
 * is somewhere filters send things to be ignored.
 */
export const TEST_ACCOUNTING_MAILBOX = "jake@protectmyhoa.com";

const PRODUCTION: Record<MailboxKind, string> = {
  lead: PRODUCTION_LEAD_MAILBOX,
  internal: PRODUCTION_INTERNAL_MAILBOX,
  accounting: PRODUCTION_ACCOUNTING_MAILBOX,
  owner: PRODUCTION_OWNER_MAILBOX,
};

const NON_PRODUCTION: Record<MailboxKind, string> = {
  lead: TEST_MAILBOX,
  internal: TEST_MAILBOX,
  accounting: TEST_ACCOUNTING_MAILBOX,
  // The plus-address, NOT the owner's real box. Unlike the remittance split,
  // this report does not have to be read off staging to be checked — a
  // rendered preview shows the same thing — and a second rollup arriving every
  // morning from an environment full of test fixtures is how the real one
  // stops being read.
  owner: TEST_MAILBOX,
};

/**
 * The mailbox for this kind of mail on this branch.
 *
 * Only `main` gets a production address. Every other branch — staging, a
 * sandbox, a preview, a renamed branch — gets the test box, and that direction
 * is the point: an unrecognised branch mailing the live inbox is invisible until
 * someone notices test threads in the queue, while a real message arriving at
 * the test address is obvious and fixable. The unsafe default cannot be detected
 * from outside; the safe one costs nothing.
 */
export function resolveMailbox(
  kind: MailboxKind,
  branch: string | undefined
): string {
  return branch === "main" ? PRODUCTION[kind] : NON_PRODUCTION[kind];
}
