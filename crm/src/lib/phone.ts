/**
 * Phone numbers, in the two shapes this CRM needs them.
 *
 * Numbers are stored free-form, exactly as typed. `Contact.phone` and
 * `UserProfile.mobilePhone` are both `a.string()` rather than `a.phone()`
 * because that type accepts only E.164 and rejects `(508) 233-2261` along
 * with every extension anyone has ever written on a business card.
 * Normalising therefore happens at the point of use — and there are two
 * points of use that want two different answers, which is the whole reason
 * this module exists rather than one exported function.
 *
 * Lifted here from `amplify/functions/lead-intake/sms.ts`, which owned
 * `toE164` when texting producers was the only thing that needed it. The
 * phone index needs it too, and a second implementation would be a second set
 * of bugs — so it moved to where both a Lambda and a page can import it, the
 * way `src/lib/pagination.ts` already is.
 */

/**
 * A number in E.164, or `null` if it isn't one.
 *
 * This is the *sending* shape: what SNS and Dialpad will accept as a
 * destination. Anything already in `+…` form is trusted as-is, which is the
 * only way a non-US number can work at all.
 *
 * `null` rather than a guess: publishing to a malformed number is a silent
 * per-message failure in the SNS console, and the person who typed it would
 * never learn their alerts were going nowhere.
 *
 * An extension makes a number unsendable and this says so by returning
 * `null` — you cannot text `x212`. Use `callerIdE164` where the question is
 * "whose number is this" rather than "can I send to it".
 */
export function toE164(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    // E.164 allows up to 15 digits; fewer than 8 is not a phone number.
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/**
 * A trailing extension, in the shapes people write them.
 *
 * Anchored at the end and requiring a marker — `x`, `ext`, `#`, or the comma
 * that means a dial pause. Bare trailing digits are NOT an extension: that
 * would eat the last four digits of every number written without separators.
 */
const TRAILING_EXTENSION =
  /(?:\s*(?:x|ext\.?|extension)\s*|\s*#\s*|\s*,\s*)\d+\s*$/i;

/**
 * The E.164 number an inbound call from this contact would most likely
 * arrive on, or `null`.
 *
 * This is the *matching* shape, and it differs from `toE164` in one way: it
 * drops a trailing extension first. A contact stored as `508-233-2261 x14`
 * cannot be texted, so `toE164` correctly refuses it — but when that person
 * rings, caller ID shows the main number, and refusing to index them means
 * every call they make lands in the triage queue forever.
 *
 * Two people at one management company with different extensions therefore
 * index to the same number. That is not a defect: they are both genuine
 * candidates for that call, and the resolver's AMBIGUOUS path is what exists
 * to say so.
 *
 * A field holding two numbers (`508-233-2261 / 508-555-1000`) yields `null`
 * rather than picking one. The digits run together into something that is not
 * a phone number, `toE164` rejects it, and the contact goes unindexed — a
 * call from either number reaches triage, where a human can see both. Wrong
 * in the safe direction, and not worth guessing about until it shows up.
 */
export function callerIdE164(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  return toE164(trimmed.replace(TRAILING_EXTENSION, ""));
}
