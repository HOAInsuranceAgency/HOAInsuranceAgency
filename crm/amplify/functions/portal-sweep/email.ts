import { AGENCY, AGENCY_FMT } from "../../../../shared/agency";
import { REQUESTED_DOCUMENTS } from "../../../../shared/leadDocuments";

/**
 * The "documents have arrived" email. Pure: no SES, no data client.
 *
 * Internal mail, so it is allowed to look like a report. The rules that keep the
 * lead-facing auto-reply plain do not apply here — nobody on the team is
 * deciding whether to trust us. What matters is that it can be read on a phone
 * in four seconds and answers: who, what, and is it worth ringing them now.
 */

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c]};`);

/** One line of the "what arrived" list. */
export interface ArrivedSection {
  /** The checklist label, e.g. "Loss runs". */
  label: string;
  count: number;
}

export interface NotificationInput {
  associationName: string;
  accountId: string;
  /** Sections that received files in this batch, in checklist order. */
  arrived: ArrivedSection[];
  /**
   * What extraction read out of them, already narrowed to fields with values.
   * Empty when nothing was extractable or extraction found nothing.
   */
  extracted: Record<string, string>;
  /** Checklist sections still empty, so a producer knows what to chase. */
  outstanding: string[];
  crmBaseUrl: string;
}

/** `masterPolicyExpiration` → `Master policy expiration`. */
function humanize(field: string): string {
  const spaced = field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * Group a batch of documents into checklist order.
 *
 * Ordered by `REQUESTED_DOCUMENTS` rather than by arrival, so the list reads the
 * same way every time and the same way as the page the lead used.
 */
export function arrivedSections(
  documents: readonly { category?: string | null }[]
): ArrivedSection[] {
  const counts = new Map<string, number>();
  for (const d of documents) {
    if (!d.category) continue;
    counts.set(d.category, (counts.get(d.category) ?? 0) + 1);
  }
  return REQUESTED_DOCUMENTS.flatMap((r) => {
    const count = counts.get(r.category) ?? 0;
    return count > 0 ? [{ label: r.label, count }] : [];
  });
}

/** The total, for the subject line and the opening sentence. */
export const totalArrived = (arrived: readonly ArrivedSection[]): number =>
  arrived.reduce((n, a) => n + a.count, 0);

export interface RenderedNotification {
  subject: string;
  text: string;
  html: string;
}

export function renderNotification(input: NotificationInput): RenderedNotification {
  const {
    associationName,
    accountId,
    arrived,
    extracted,
    outstanding,
    crmBaseUrl,
  } = input;

  const total = totalArrived(arrived);
  const noun = total === 1 ? "document" : "documents";
  // Named in the subject, because this lands in a shared mailbox where the
  // association is the only thing that tells one of these from another.
  const subject = `${associationName}: ${total} ${noun} received`;

  const link = `${crmBaseUrl.replace(/\/$/, "")}/accounts/${accountId}`;
  const extractedRows = Object.entries(extracted);

  const text = [
    `${associationName} sent ${total} ${noun} through their upload page.`,
    "",
    ...arrived.map((a) => `  ${a.count} x ${a.label}`),
    ...(extractedRows.length
      ? ["", "Read from them:", ...extractedRows.map(([k, v]) => `  ${humanize(k)}: ${v}`)]
      : ["", "Nothing could be read from them automatically."]),
    ...(outstanding.length
      ? ["", `Still outstanding: ${outstanding.join(", ")}.`]
      : ["", "That completes the list."]),
    "",
    link,
  ].join("\n");

  const p = (content: string, margin = "0 0 14px") =>
    `      <p style="font:400 15px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#334155;margin:${margin}">${content}</p>`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#f1f5f9">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:10px;overflow:hidden">
        <tr><td style="background:#142a4c;padding:16px 24px">
          <div style="font:700 15px/1.3 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#ffffff">Documents received</div>
        </td></tr>
        <tr><td style="padding:22px 24px 4px">
${p(`<strong style="color:#0f172a">${escapeHtml(associationName)}</strong> sent ${total} ${noun} through their upload page.`)}
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px">
${arrived
  .map(
    (a) =>
      `            <tr><td style="padding:2px 10px 2px 0;font:700 14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#142a4c;text-align:right">${a.count}</td><td style="padding:2px 0;font:400 14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#334155">${escapeHtml(a.label)}</td></tr>`
  )
  .join("\n")}
          </table>
${
  extractedRows.length
    ? `          <div style="border-top:1px solid #e2e8f0;padding-top:14px;margin-bottom:14px">
${p('<span style="font-weight:600;color:#0f172a">Read from them</span>', "0 0 8px")}
            <table role="presentation" cellpadding="0" cellspacing="0">
${extractedRows
  .map(
    ([k, v]) =>
      `              <tr><td style="padding:2px 12px 2px 0;font:400 13.5px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#64748b;white-space:nowrap">${escapeHtml(humanize(k))}</td><td style="padding:2px 0;font:600 13.5px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">${escapeHtml(v)}</td></tr>`
  )
  .join("\n")}
            </table>
          </div>`
    : p(
        '<span style="color:#64748b">Nothing could be read from them automatically.</span>',
        "0 0 14px"
      )
}
${
  outstanding.length
    ? p(
        `<span style="color:#64748b">Still outstanding: ${escapeHtml(outstanding.join(", "))}.</span>`,
        "0 0 18px"
      )
    : p('<span style="color:#1f8b4c">That completes the list.</span>', "0 0 18px")
}
          <a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;border-radius:6px;background:#142a4c;color:#ffffff;font:700 14px/1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;text-decoration:none">Open the account</a>
        </td></tr>
        <tr><td style="padding:18px 24px 22px">
          <div style="border-top:1px solid #e2e8f0;padding-top:12px;font:400 12px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#94a3b8">${escapeHtml(AGENCY.name)} · ${escapeHtml(AGENCY_FMT.emailLower)}</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}
