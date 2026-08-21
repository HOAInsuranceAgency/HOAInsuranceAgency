/**
 * The cancellation notice sequence — where lender liability lives.
 *
 * The order is fixed and nothing skips: default → written notice of intent to
 * cancel → USPS certificate of mailing recorded → 15 days elapse → only then
 * a cancellation request to the carrier. Fifteen days is the longest
 * requirement anywhere, applied everywhere, so there is exactly one process;
 * the certificate is a Massachusetts requirement applied nationally so every
 * file has provable mailing.
 *
 * Pure, so the rules are assertable without a table. The rows it reads are
 * immutable PfNotice records the servicing Lambda creates with server-set
 * timestamps — the UI cannot back-date a step because no client can write
 * these rows at all.
 */

export const NOTICE_DAYS = 15;
export const CARRIER_REFUND_DAYS = 30;

export interface NoticeRow {
  id: string;
  type: "INTENT_TO_CANCEL" | "CERT_OF_MAILING" | "CANCELLATION_REQUEST";
  occurredAt: string;
  /** Intent rows: when the 15-day clock runs out. */
  clockExpiresAt?: string | null;
  /** Cert and cancellation rows: the intent they belong to. */
  refNoticeId?: string | null;
}

/** ISO instant + n days. */
export function addDaysIso(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

/** The latest intent, with whether its certificate has been recorded. */
export function latestIntent(notices: readonly NoticeRow[]): {
  intent: NoticeRow | null;
  certified: boolean;
} {
  const intents = notices
    .filter((n) => n.type === "INTENT_TO_CANCEL")
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const intent = intents[0] ?? null;
  const certified =
    !!intent &&
    notices.some((n) => n.type === "CERT_OF_MAILING" && n.refNoticeId === intent.id);
  return { intent, certified };
}

export type SequenceVerdict = { ok: true } | { ok: false; reason: string };

/**
 * May a cancellation request go to the carrier now?
 *
 * Three refusals, in the order a servicer hits them, each naming the missing
 * step rather than a generic no. The clock runs from the notice, not from the
 * certificate — the statute's fifteen days are days since notice was mailed —
 * but the certificate must exist before anything advances, because a notice
 * we cannot prove was mailed is a notice that was not mailed.
 */
export function canRequestCancellation(
  notices: readonly NoticeRow[],
  nowIso: string
): SequenceVerdict {
  const { intent, certified } = latestIntent(notices);
  if (!intent) {
    return {
      ok: false,
      reason: "No notice of intent to cancel has been sent. That is step one, and it starts the 15-day clock.",
    };
  }
  if (!certified) {
    return {
      ok: false,
      reason: "The certificate of mailing for the intent notice has not been recorded. Record the USPS certificate before anything advances.",
    };
  }
  const expires = intent.clockExpiresAt ?? addDaysIso(intent.occurredAt, NOTICE_DAYS);
  if (nowIso < expires) {
    return {
      ok: false,
      reason: `The 15-day notice period runs until ${expires.slice(0, 10)}. A cancellation request before then is exactly the liability this sequence exists to prevent.`,
    };
  }
  if (notices.some((n) => n.type === "CANCELLATION_REQUEST")) {
    return { ok: false, reason: "A cancellation request has already been made on this loan." };
  }
  return { ok: true };
}

/** May a certificate be recorded against this notice? */
export function canRecordCert(
  notices: readonly NoticeRow[],
  noticeId: string
): SequenceVerdict {
  const intent = notices.find(
    (n) => n.id === noticeId && n.type === "INTENT_TO_CANCEL"
  );
  if (!intent) {
    return { ok: false, reason: "That notice does not exist, or is not an intent notice." };
  }
  if (notices.some((n) => n.type === "CERT_OF_MAILING" && n.refNoticeId === noticeId)) {
    return { ok: false, reason: "A certificate is already recorded for that notice." };
  }
  return { ok: true };
}
