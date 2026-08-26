import { callerIdE164 } from "../../../src/lib/phone";
import type { PhoneLinkSource } from "../../../src/lib/enums";

/**
 * What the phone index should hold, given a row that just changed.
 *
 * Pure — no DynamoDB, no data client — so the rules about which numbers get
 * indexed, under what id, and when a link should disappear are testable
 * without mocking a stream. `handler.ts` does the reading and the writing.
 * Same split as `stripe-webhook`'s decide/persist.
 */

/**
 * Link ids are derived from the row they project, never generated.
 *
 * That single decision is what makes this handler idempotent, and idempotence
 * is what makes at-least-once stream delivery a non-issue: a redelivered
 * batch rewrites the same rows with the same content. It is also what makes
 * "the number changed" a plain overwrite instead of an insert plus a hunt for
 * the stale row it replaced.
 *
 * Prefixed rather than bare so the two namespaces cannot collide and so a row
 * says what maintains it when you are looking at it in the console.
 */
export const contactLinkId = (contactId: string) => `contact:${contactId}`;
export const accountLinkId = (accountId: string) => `account:${accountId}`;

/** A row the index should contain. `linkedAt` is stamped by the writer. */
export interface DesiredLink {
  id: string;
  e164: string;
  accountId: string;
  contactId: string | null;
  accountName: string | null;
  contactName: string | null;
  source: PhoneLinkSource;
}

/**
 * What the handler should do about one stream record.
 *
 * `renameAccount` and `purgeAccount` fan out to rows this function cannot
 * see — every link under an account — so they name the work rather than
 * describing the result. The handler resolves them through the accountId
 * index.
 */
export type Plan =
  | { kind: "upsert"; link: DesiredLink }
  | { kind: "delete"; id: string }
  | { kind: "renameAccount"; accountId: string; accountName: string }
  | { kind: "purgeAccount"; accountId: string };

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v : null;

/**
 * The plan for a `Contact` write.
 *
 * A contact is one row in the index at most, because `Contact.phone` is one
 * field. So every outcome here is "this id should hold this" or "this id
 * should hold nothing", and a contact whose number is cleared, made
 * unparseable, or deleted takes the same path as one that never had a number.
 *
 * `accountName` is passed in because the Contact image does not carry it —
 * the handler resolves and caches it. Null is acceptable: a link with no
 * account name still matches, it just reads worse in the triage queue, and an
 * account rename refreshes it.
 */
export function planForContact(
  oldImage: Record<string, unknown> | undefined,
  newImage: Record<string, unknown> | undefined,
  accountName: string | null
): Plan[] {
  const image = newImage ?? oldImage;
  const contactId = str(image?.id);
  if (!contactId) return [];

  const id = contactLinkId(contactId);
  // A REMOVE carries only an old image, and a cleared number carries a new
  // one with nothing in it. Both mean the same thing to the index.
  if (!newImage) return [{ kind: "delete", id }];

  const accountId = str(newImage.accountId);
  const e164 = callerIdE164(str(newImage.phone));
  if (!accountId || !e164) return [{ kind: "delete", id }];

  return [
    {
      kind: "upsert",
      link: {
        id,
        e164,
        accountId,
        contactId,
        accountName,
        contactName: str(newImage.name),
        source: "CONTACT",
      },
    },
  ];
}

/**
 * The plan for an `Account` write. Up to two things at once.
 *
 * ── Why `Account.contactPhone` is indexed at all ───────────────────────
 * It is a deprecated column: the schema says nothing reads or writes it any
 * more, and it is kept only until the Contact backfill has been verified.
 * Indexing it anyway costs one row per legacy account and buys coverage for
 * exactly the accounts most likely to be called about — leads created before
 * contacts existed. Where both are present the number resolves to the same
 * account twice, which the resolver collapses; duplicate *candidates* would
 * be a bug, duplicate *rows pointing at one account* are not.
 *
 * When the deprecated columns are finally dropped, this half goes with them
 * and nothing else here changes.
 *
 * ── Why a rename fans out ──────────────────────────────────────────────
 * `PhoneLink.accountName` is denormalised, and unlike `Activity.actorName` it
 * is not history: it labels a live candidate in a queue of unidentified
 * calls. A stale name there is a puzzle rather than a record, so a rename
 * rewrites the links instead of being preserved by them.
 */
export function planForAccount(
  oldImage: Record<string, unknown> | undefined,
  newImage: Record<string, unknown> | undefined
): Plan[] {
  const image = newImage ?? oldImage;
  const accountId = str(image?.id);
  if (!accountId) return [];

  // A deleted account must not leave links behind: an orphan row would offer
  // a dead association as a candidate for a live call. Its contacts are not
  // necessarily deleted with it, so their links are this function's problem.
  if (!newImage) return [{ kind: "purgeAccount", accountId }];

  const plans: Plan[] = [];
  const e164 = callerIdE164(str(newImage.contactPhone));
  const accountName = str(newImage.name);

  plans.push(
    e164
      ? {
          kind: "upsert",
          link: {
            id: accountLinkId(accountId),
            e164,
            accountId,
            contactId: null,
            accountName,
            contactName: str(newImage.contactFirstName)
              ? [str(newImage.contactFirstName), str(newImage.contactLastName)]
                  .filter(Boolean)
                  .join(" ")
              : null,
            source: "ACCOUNT",
          },
        }
      : { kind: "delete", id: accountLinkId(accountId) }
  );

  // Only when it actually changed. Every account write would otherwise fan
  // out across its contacts' links to rewrite them with what they already say.
  const wasNamed = str(oldImage?.name);
  if (accountName && oldImage && wasNamed !== accountName) {
    plans.push({ kind: "renameAccount", accountId, accountName });
  }

  return plans;
}
