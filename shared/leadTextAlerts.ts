/**
 * Who gets texted when a web lead lands, and what the text says.
 *
 * Pure — no SNS, no data client — so the rules about who is notified and what
 * they are told are testable without mocking either. `handler.ts` does the
 * reading and the sending.
 */

/** The `UserProfile` fields this reads. Structural, so a Schema row fits. */
export interface NotifiableProfile {
  firstName?: string | null;
  lastName?: string | null;
  mobilePhone?: string | null;
  leadTextAlerts?: boolean | null;
}

/** What a lead text needs to say. */
export interface LeadSummary {
  id: string;
  name: string;
  city?: string | null;
  state?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  source?: string | null;
}

/**
 * A US mobile number in E.164, or `null` if it isn't one.
 *
 * Numbers are stored as typed, so this is where the shapes people actually
 * use — `(508) 233-2261`, `508.233.2261`, `1-508-233-2261` — become the one
 * shape SNS accepts. Anything already in `+…` form is trusted as-is, which is
 * the only way a non-US number can work at all.
 *
 * `null` rather than a guess: publishing to a malformed number is a silent
 * per-message failure in the SNS console, and the person who typed it would
 * never learn their alerts were going nowhere.
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

/** Display name for a profile, for logs — never for the message body. */
export const profileName = (p: NotifiableProfile): string =>
  [p.firstName, p.lastName].filter(Boolean).join(" ").trim() || "(unnamed)";

/**
 * The profiles that asked for a text and left a number we can reach.
 *
 * Both conditions, and the number is the reason the toggle alone is not
 * enough: turning the switch on without saving a mobile number is the obvious
 * way to end up believing you are covered when nothing will ever arrive. The
 * caller logs that case rather than dropping it silently.
 */
export function textRecipients(
  profiles: NotifiableProfile[]
): { profile: NotifiableProfile; phone: string }[] {
  const out: { profile: NotifiableProfile; phone: string }[] = [];
  const seen = new Set<string>();
  for (const p of profiles) {
    if (!p.leadTextAlerts) continue;
    const phone = toE164(p.mobilePhone);
    if (!phone) continue;
    // Two profiles sharing a number get one text, not two.
    if (seen.has(phone)) continue;
    seen.add(phone);
    out.push({ profile: p, phone });
  }
  return out;
}

/** Opted in but unreachable — worth a log line, not a text. */
export const unreachableOptIns = (profiles: NotifiableProfile[]) =>
  profiles.filter((p) => p.leadTextAlerts && !toE164(p.mobilePhone));

/**
 * The message body.
 *
 * Built to survive as one SMS segment where it can: 160 GSM-7 characters, and
 * every message carries the link, so the association name is what gets
 * truncated rather than the thing you need to act. No emoji and no smart
 * punctuation — a single non-GSM character silently re-encodes the whole
 * message as UCS-2 and halves the limit to 70.
 */
export const SMS_SEGMENT = 160;

export function leadText(lead: LeadSummary, baseUrl: string): string {
  const link = `${baseUrl.replace(/\/$/, "")}/accounts/${lead.id}`;
  const where = [lead.city, lead.state].filter(Boolean).join(", ");
  const who = [lead.contactName, lead.contactPhone].filter(Boolean).join(" ");
  const detail = [where, who].filter(Boolean).join(" - ");

  const head = "New HOA lead: ";
  const parts = detail ? 3 : 2;
  // Everything but the association name is a fixed cost, including the ". "
  // between each part. Whatever is left is the name's.
  const fixed =
    head.length + link.length + detail.length + (parts - 1) * 2;
  const room = Math.max(12, SMS_SEGMENT - fixed);
  const name =
    lead.name.length > room
      ? `${lead.name.slice(0, room - 3).trimEnd()}...`
      : lead.name;

  return [`${head}${name}`, detail, link].filter(Boolean).join(". ");
}
