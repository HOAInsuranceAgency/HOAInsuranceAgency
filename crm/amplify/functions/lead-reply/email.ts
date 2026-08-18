import { AGENCY, AGENCY_FMT } from "../../../../shared/agency";

/**
 * The auto-reply's prompt and its wrapper. Pure: no SDK calls, no SES.
 *
 * ## What this email is for
 *
 * A board member who filled in a form at 9pm should hear back in minutes, from
 * a real named producer, about their own association — not a receipt. So the
 * body is generated, and it is generated from everything the lead actually told
 * us plus anything extraction pulled out of their documents.
 *
 * ## The one hard line
 *
 * It must not quote a premium, state a limit or deductible as if it applied,
 * confirm coverage, or promise an outcome. Those are statements a licensed
 * agency is answerable for and a model cannot make on the agency's behalf.
 * Everything else — naming the lines they asked about, reflecting what their
 * declaration page shows, saying what happens next and what to send — is fair
 * game and is what makes the email worth sending.
 *
 * That boundary lives in the system prompt and is repeated in the schema of
 * what we ask for, because a single instruction is easier to drift past than
 * an instruction plus a shape that has nowhere to put a number.
 */

/** Everything the prompt gets to see about one lead. */
export interface LeadContext {
  name: string;
  contactName?: string | null;
  contactFirstName?: string | null;
  state?: string | null;
  city?: string | null;
  unitCount?: number | null;
  /** Free-text notes captured by the form — role, coverage lines, questions. */
  notes?: string | null;
  source?: string | null;
  /** Filenames the visitor attached, if any. */
  documentNames: string[];
  /**
   * Extraction output, already narrowed to fields that were found. Shape is
   * `{ field: value }` — confidence and evidence are dropped before we get
   * here, because a model shown a confidence score starts hedging in prose.
   */
  extracted?: Record<string, string> | null;
}

/** A function, not a constant: the producer's real name goes in the prompt. */
export const systemPrompt = (producerName: string) =>
  `You write the first reply from an insurance agency to someone who has just asked for a review of their community association's insurance.

You are writing as ${producerName}, a licensed producer at ${AGENCY.name}. Write in first person, plainly, the way a competent broker writes a short email. British-isms out; this is a US agency.

WHAT YOU MUST NOT DO. These are regulated statements and you are not authorised to make them:
- Never quote, estimate, or imply a premium, rate, or price.
- Never state a limit, deductible, or coverage term as though it applies to them.
- Never say they are covered, will be covered, or that a policy is in place.
- Never promise an outcome, a saving, or a specific carrier.
- Never invent a fact about their association. If you were not told it, do not say it.

WHAT MAKES THIS EMAIL WORTH SENDING:
- Name their association and, where you know it, their state and unit count.
- Reflect back what they actually asked about, in your own words, so it is obvious a person read it.
- Where a document was attached and read, refer to what it shows concretely: the carrier on the declaration page, the expiry date, the lines listed. Describing what their own document says is reporting, not advising.
- Say what happens next and roughly when.
- Ask for at most two specific things that would speed the review up, chosen from what is actually missing.

HOW TO SOUND LIKE A PERSON. This matters as much as the content. A reader who suspects this was generated will not reply to it.

You are a working broker typing a quick reply between calls. Not a support desk, not a system. Write the way you would if you had read their form on your phone and had four minutes.

DO NOT WRITE A GREETING OR A SIGN-OFF. Both are added around your text, using the reader's real name. Your first word is the first word of the first paragraph.

OPEN ON SOMETHING SPECIFIC. Name their association in the first sentence. Refer to the thing they actually asked about. Do not thank them for contacting you, do not tell them their request was received, and do not repeat anything the confirmation page already said.

STRUCTURE, and this is where generated email gives itself away:
- Do NOT enumerate. No "Two things would help", no "First... Second...", no lists in prose.
- Do NOT justify each request. Asking "can you dig out the dec pages and the loss runs?" is enough; explaining why underwriters want them is padding.
- Do NOT write three tidy paragraphs of similar length. Vary them. One paragraph can be a single sentence.
- Do NOT give one paragraph per job (acknowledge, then next step, then asks). Let them run together the way a person's do.
- Do NOT close with a summary of what you just said.

VOICE:
- Contractions throughout. "I'll", "you're", "I've", "don't", "can't".
- Hyphenate compound modifiers: a 12-unit association, not a 12 unit association.
- Say "I", not "we", except where the agency really is the actor.
- One mild, concrete aside is welcome if the facts support it ("September gives us room" beats "that gives us plenty of runway, which helps").
- Never explain your own process in the abstract. "I'll pull the underwriting picture together" is broker-speak; "I'll get your program in front of the markets that write this" is what one would actually say.

NEVER use an em dash or an en dash. Not for asides, not for emphasis, not anywhere. A comma, a full stop, or brackets.

NEVER open with: "I hope this email finds you well", "I wanted to reach out", "Thank you for reaching out", "Thanks for the request", "I'm writing to", "Just following up".

NEVER close with: "Feel free to", "Don't hesitate to", "Looking forward to hearing from you", "Let me know if you have any questions".

NEVER use: delve, leverage, robust, seamless, streamline, landscape, navigate, elevate, unlock, tailored, bespoke, holistic, comprehensive, ensure, utilise, facilitate, foster, myriad, plethora, testament, realm, journey, empower, crucial, vital, pivotal, runway.

NEVER use: "It's worth noting that", "That said,", "Moreover", "Furthermore", "In today's world", "not only X but also Y", "It's not just X, it's Y", a sentence that restates the one before it, a rhetorical question you then answer.

No exclamation marks. No emoji. No headings. No bullets. No markdown. No bold.

LENGTH: 80 to 140 words. Shorter than feels complete. If you are padding to reach a length, stop.

Return only the fields asked for. Plain text in the body. Separate paragraphs with a blank line.`;

/** Structured output, so the model has nowhere to put a number we don't want. */
export const REPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "body", "askedFor"],
  properties: {
    subject: {
      type: "string",
      description:
        "Email subject. Name the association. Under 70 characters. No 'Re:' and no exclamation marks.",
    },
    body: {
      type: "string",
      description:
        "The email body as plain text, paragraphs separated by a blank line. No greeting line and no sign-off; both are added around it.",
    },
    askedFor: {
      type: "array",
      description:
        "The specific things you asked them to send, 0-2 items, each a short noun phrase. Empty if you asked for nothing.",
      items: { type: "string" },
    },
  },
} as const;

/** The user-turn content: everything known about this lead, as plain labels. */
export function buildPrompt(lead: LeadContext): string {
  const lines: string[] = [
    `Association: ${lead.name}`,
    lead.contactName ? `Contact: ${lead.contactName}` : null,
    lead.city || lead.state
      ? `Location: ${[lead.city, lead.state].filter(Boolean).join(", ")}`
      : null,
    lead.unitCount ? `Units: ${lead.unitCount}` : null,
    lead.source ? `Came from: ${lead.source}` : null,
  ].filter((l): l is string => l !== null);

  if (lead.notes?.trim()) {
    lines.push("", "What they told us on the form:", lead.notes.trim());
  }

  if (lead.documentNames.length) {
    lines.push("", `They attached: ${lead.documentNames.join(", ")}`);
  }

  const extracted = Object.entries(lead.extracted ?? {}).filter(
    ([, v]) => typeof v === "string" && v.trim() !== ""
  );
  if (extracted.length) {
    lines.push(
      "",
      "Read from their documents. You may refer to these as what their document shows:",
      ...extracted.map(([k, v]) => `${humanize(k)}: ${v}`)
    );
  } else if (lead.documentNames.length) {
    lines.push(
      "",
      "Nothing could be read from the attachments, so do not refer to their contents."
    );
  }

  return lines.join("\n");
}

/** `masterPolicyExpiration` → `Master policy expiration`. */
function humanize(field: string): string {
  const spaced = field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c]};`);

/**
 * Phrases and words the prompt forbids, kept here so drift is *detectable*.
 *
 * Deliberately not removed automatically. Cutting a phrase out of finished
 * prose leaves a sentence that reads worse than the tell did, and a model that
 * has ignored the instruction has usually ignored it structurally rather than
 * in one splice. So these are logged and the email still goes: a warning in
 * CloudWatch is how you find out the prompt needs tightening, whereas mangled
 * grammar is how a lead finds out.
 */
const AI_TELLS = [
  "i hope this email finds you well",
  "i wanted to reach out",
  "thank you for reaching out",
  "just following up",
  "feel free to",
  "don't hesitate",
  "do not hesitate",
  "looking forward to hearing",
  "let me know if you have any questions",
  "it's worth noting",
  "that said,",
  "moreover",
  "furthermore",
  "in today's",
  "delve",
  "leverage",
  "seamless",
  "streamline",
  "holistic",
  "bespoke",
  "myriad",
  "plethora",
  "testament",
  "empower",
  "not only",
];

/**
 * Strip the one tell worth fixing mechanically.
 *
 * Models reliably ignore "never use an em dash", so instructing it is not
 * enough. A dash is also the only tell that can be substituted without
 * touching meaning: every em dash in this position is a parenthetical or an
 * appositive, and a comma reads correctly in both. Everything else in
 * `AI_TELLS` is prose that has to be regenerated, not patched.
 *
 * Spaced dashes collapse with their spaces so "coverage — nothing" becomes
 * "coverage, nothing" rather than "coverage , nothing".
 */
export function stripDashes(text: string): string {
  return text
    .replace(/\s*[—–]\s*/g, ", ")
    // A double hyphen is the same habit typed differently.
    .replace(/\s*--\s*/g, ", ")
    // A dash that opened a clause can leave ", ," behind once the sentence
    // already had a comma.
    .replace(/,\s*,/g, ",")
    .replace(/,\s*\./g, ".")
    .trim();
}

/** Which forbidden phrases survived, for the log. Never shown to the lead. */
export function findAiTells(text: string): string[] {
  const lower = text.toLowerCase();
  return AI_TELLS.filter((t) => lower.includes(t));
}

export interface RenderedReply {
  subject: string;
  text: string;
  html: string;
}

/**
 * Wrap the generated body in the greeting, sign-off and disclosure.
 *
 * The frame is ours, not the model's: the greeting has to use the right first
 * name, the sign-off has to name a real producer with the agency's real phone,
 * and the closing line has to say the review has not happened yet. Leaving any
 * of those to generation is how an email ends up signed by nobody.
 */
export function renderReply(opts: {
  generated: { subject: string; body: string };
  lead: LeadContext;
  producerName: string;
}): RenderedReply {
  const { lead, producerName } = opts;
  /**
   * The generated text is cleaned here rather than trusted from the model.
   * `renderReply` is the single point every send goes through, so this is the
   * one place that can guarantee no dash reaches a lead.
   */
  const generated = {
    subject: stripDashes(opts.generated.subject),
    body: stripDashes(opts.generated.body),
  };
  const tells = findAiTells(`${generated.subject}\n${generated.body}`);
  if (tells.length) {
    console.warn(
      `[lead-reply] generated copy contains forbidden phrasing: ${tells.join(", ")}`
    );
  }
  const first =
    lead.contactFirstName?.trim() ||
    lead.contactName?.trim().split(/\s+/)[0] ||
    null;
  const greeting = first ? `Hi ${first},` : "Hello,";

  const paragraphs = generated.body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const signOff = [
    producerName,
    `${AGENCY.name}`,
    AGENCY.phone,
    AGENCY_FMT.emailLower,
  ];

  /**
   * Said plainly, every time, and not by the model.
   *
   * The email describes and asks; it does not quote or bind. A reader who takes
   * it as confirmation of cover is the one misunderstanding worth spending two
   * sentences to prevent.
   */
  /**
   * One sentence, not three.
   *
   * The substance is unchanged and non-negotiable: not a quote, not confirmation
   * of coverage, nothing bound without a written offer. But a long legalistic
   * block under the signature is itself a tell, and the whole point of this
   * email is that it reads as written by a person.
   */
  const disclosure =
    "Not a quote or confirmation of coverage. Nothing is bound until you've " +
    "accepted a written offer.";

  const text = [
    greeting,
    "",
    ...paragraphs.flatMap((p) => [p, ""]),
    ...signOff,
    "",
    // A rule of hyphens, not an em dash: the email forbids the character and
    // that has to include the parts we write.
    "---",
    disclosure,
  ].join("\n");

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#f1f5f9">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,.08)">
        <tr><td style="background:#142a4c;padding:18px 28px">
          <div style="font:700 15px/1.3 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#ffffff">${escapeHtml(AGENCY.name)}</div>
        </td></tr>
        <tr><td style="padding:26px 28px 8px">
          <p style="font:400 15px/1.65 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;margin:0 0 14px">${escapeHtml(greeting)}</p>
${paragraphs
  .map(
    (p) =>
      `          <p style="font:400 15px/1.65 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#334155;margin:0 0 14px">${escapeHtml(p)}</p>`
  )
  .join("\n")}
        </td></tr>
        <tr><td style="padding:6px 28px 20px">
          <div style="font:400 15px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
            <div style="font-weight:600">${escapeHtml(producerName)}</div>
            <div style="color:#475569;font-size:14px">${escapeHtml(AGENCY.name)}</div>
            <div style="font-size:14px"><a href="${AGENCY_FMT.phoneHref}" style="color:#142a4c">${escapeHtml(AGENCY.phone)}</a> · <a href="mailto:${AGENCY_FMT.emailLower}" style="color:#142a4c">${escapeHtml(AGENCY_FMT.emailLower)}</a></div>
          </div>
        </td></tr>
        <tr><td style="padding:0 28px 26px">
          <div style="border-top:1px solid #e2e8f0;padding-top:14px;font:400 12px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#94a3b8">${escapeHtml(disclosure)}</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject: generated.subject, text, html };
}
