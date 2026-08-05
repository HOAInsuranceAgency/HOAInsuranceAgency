/**
 * Which of an account's contacts stands for the account.
 *
 * Two questions, asked in three places — the ACORD mapping fills the insured
 * block and the 125's inspection block, and the accounts list shows one name
 * per row — so they are answered once, here, rather than three times with
 * three tie-breaks.
 *
 * Structurally typed and dependency-free: callers hand in whatever rows they
 * have, and a Lambda could import this for the same reason it can import
 * `pagination.ts`.
 */

export interface ContactLike {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  type?: string | null;
  isPrimary?: boolean | null;
}

/**
 * The contact whose name, phone and email represent the applicant.
 *
 * The flagged primary, and the first contact when nothing is flagged. The
 * fallback is not a nicety. An account backfilled from the old
 * `Account.contactPhone` column gets its flag set by the migration, and a
 * contact added through the card takes it when it is the only one — but a row
 * created by a Lambda that failed half-way, or an account whose primary was
 * deleted, would otherwise put a blank in the insured block of a carrier
 * submission. One contact that might be the wrong one beats no contact at all,
 * and the producer can see which it picked.
 */
export function primaryContact<T extends ContactLike>(contacts: T[]): T | undefined {
  return contacts.find((c) => c.isPrimary) ?? contacts[0];
}

/**
 * Who the carrier's inspector calls to get on site, if anyone.
 *
 * No fallback, deliberately: the 125's inspection block is filled only when
 * someone has actually been named for it. Guessing here would print the
 * accountant's phone number under "call this person to arrange access", and a
 * blank is the honest answer.
 */
export function inspectionContact<T extends ContactLike>(
  contacts: T[]
): T | undefined {
  return contacts.find((c) => c.type === "INSPECTION");
}
