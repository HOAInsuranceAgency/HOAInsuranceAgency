/**
 * The raw MIME message for an invoice, because SES's `Simple` content cannot
 * carry an attachment.
 *
 * Pure and dependency-free, so the message structure is testable without SES.
 *
 * ── The shape ───────────────────────────────────────────────────────────────
 *   multipart/mixed
 *   ├── multipart/alternative
 *   │   ├── text/plain
 *   │   └── text/html
 *   └── application/pdf  (attachment)
 *
 * The alternative nests *inside* the mixed part rather than sitting beside the
 * attachment. Put flat, a client picks one of three siblings and shows either
 * the message or the PDF, not both — the attachment is a different kind of
 * thing from the body, and only that nesting says so.
 */

/** RFC 5322 wants CRLF, and some MTAs are strict about it. */
const CRLF = "\r\n";

/** Base64, wrapped at 76 characters as RFC 2045 requires. */
function base64Lines(input: Buffer | Uint8Array | string): string {
  const b64 = Buffer.from(input as never).toString("base64");
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += 76) out.push(b64.slice(i, i + 76));
  return out.join(CRLF);
}

/**
 * A header value safe to put on one line.
 *
 * Non-ASCII is encoded per RFC 2047, because an association called "Côte
 * Village" would otherwise arrive as mojibake in the subject — the same failure
 * a missing charset caused in the licence alerts. ASCII is left alone so a
 * message in a log is still readable.
 */
export function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  // eslint-disable-next-line no-control-regex
  if (!/[^\x20-\x7E]/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

export interface MimeMessage {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  attachment?: {
    filename: string;
    contentType: string;
    content: Uint8Array;
  };
  /**
   * Injectable so tests can assert an exact message. Left out in production,
   * where each part gets a random boundary — a boundary that appeared in the
   * body would end the part early, and random 32-hex is not going to.
   */
  boundaries?: { mixed: string; alternative: string };
}

/**
 * Bcc is deliberately not a field here.
 *
 * SES takes envelope recipients from `Destination` on the send command, and a
 * `Bcc:` header in the body would be visible to everyone who received it —
 * which is the one thing a blind copy must never be.
 */
export function buildMimeMessage(msg: MimeMessage): string {
  const mixed = msg.boundaries?.mixed ?? `mixed_${randomBoundary()}`;
  const alt = msg.boundaries?.alternative ?? `alt_${randomBoundary()}`;

  const head = [
    `From: ${msg.from}`,
    `To: ${msg.to}`,
    ...(msg.replyTo ? [`Reply-To: ${msg.replyTo}`] : []),
    `Subject: ${encodeHeader(msg.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
  ];

  const body = [
    "",
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(msg.text),
    "",
    `--${alt}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(msg.html),
    "",
    `--${alt}--`,
  ];

  if (msg.attachment) {
    const name = encodeHeader(msg.attachment.filename);
    body.push(
      "",
      `--${mixed}`,
      `Content-Type: ${msg.attachment.contentType}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(msg.attachment.content)
    );
  }

  body.push("", `--${mixed}--`, "");
  return [...head, ...body].join(CRLF);
}

/**
 * 32 hex characters. Not security, just something that will not collide with
 * text in the body and end a part early.
 */
function randomBoundary(): string {
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, "0");
  }
  return out;
}
