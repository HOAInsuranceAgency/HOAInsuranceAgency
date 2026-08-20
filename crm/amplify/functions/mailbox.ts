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
export type MailboxKind = "lead" | "internal";

/** Sales. Outbound to a prospect, and the reply-to they will use. */
export const PRODUCTION_LEAD_MAILBOX = "sales@protectmyhoa.com";

/** The agency's general inbox. Internal reports and deadlines. */
export const PRODUCTION_INTERNAL_MAILBOX = "insurance@protectmyhoa.com";

/**
 * Everywhere that is not production. A plus-address on the same SES-verified
 * domain, so DKIM still applies and the suffix survives to the mailbox and can
 * be filtered.
 */
export const TEST_MAILBOX = "jake+testing@protectmyhoa.com";

const PRODUCTION: Record<MailboxKind, string> = {
  lead: PRODUCTION_LEAD_MAILBOX,
  internal: PRODUCTION_INTERNAL_MAILBOX,
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
  return branch === "main" ? PRODUCTION[kind] : TEST_MAILBOX;
}
