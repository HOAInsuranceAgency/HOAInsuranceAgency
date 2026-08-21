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
   * Whether a document-request link is being appended to this reply.
   *
   * The prompt needs to know, because the whole point of the link is that the
   * body stops asking for documents itself.
   */
  hasUploadLink?: boolean;
  /**
   * Extraction output, already narrowed to fields that were found. Shape is
   * `{ field: value }` — confidence and evidence are dropped before we get
   * here, because a model shown a confidence score starts hedging in prose.
   */
  extracted?: Record<string, string> | null;
  /**
   * Why the association name cannot be trusted, or null/absent when it can.
   *
   * `propertyNameProblem` over `Account.name`, computed where the context is
   * built. When set, the prompt tells the model to write around the name
   * rather than repeat it: the system prompt's "name their association in the
   * first sentence" is exactly wrong when the association is "test".
   */
  nameProblem?: string | null;
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

DOCUMENTS. If the lead context says a document link is being included, DO NOT ask them to send anything and DO NOT list documents. A link to a page listing exactly what we need is added below your text, and asking as well means the email asks twice and contradicts the page. One clause noting that a list is attached is the most you should write, and even that is optional. This is most of what keeps the email short.

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

BE EASY TO DEAL WITH. This is the first thing they have ever received from the agency and the only thing it has to earn is a reply. Warm, not formal. You are glad they got in touch. Make anything you ask for sound optional and low effort: "if you can lay hands on it" beats "please provide". Say you will work with whatever they have. Offering to get on a quick call instead reads as helpful; a list of requirements reads as a gate.

NEVER use an em dash or an en dash. Not for asides, not for emphasis, not anywhere. A comma, a full stop, or brackets.

NEVER open with: "I hope this email finds you well", "I wanted to reach out", "Thank you for reaching out", "Thanks for the request", "I'm writing to", "Just following up".

NEVER close with: "Feel free to", "Don't hesitate to", "Looking forward to hearing from you", "Let me know if you have any questions".

NEVER use: delve, leverage, robust, seamless, streamline, landscape, navigate, elevate, unlock, tailored, bespoke, holistic, comprehensive, ensure, utilise, facilitate, foster, myriad, plethora, testament, realm, journey, empower, crucial, vital, pivotal, runway.

NEVER use: "It's worth noting that", "That said,", "Moreover", "Furthermore", "In today's world", "not only X but also Y", "It's not just X, it's Y", a sentence that restates the one before it, a rhetorical question you then answer.

No exclamation marks. No emoji. No headings. No bullets. No markdown. No bold.

LENGTH: 45 to 80 words. This is a hard ceiling, not a target to fill.

That is short. It is meant to be. A first email that takes twenty seconds to read gets answered; one that takes ninety gets left for later. Say the one thing you noticed in their documents, say what happens next, stop. You do not have to mention everything you know. Anything you leave out, you can say on the phone.

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
        "The email body as plain text, paragraphs separated by a blank line. 45-80 words, hard ceiling. No greeting line and no sign-off; both are added around it.",
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
    /**
     * A junk association name must not reach the subject line. The system
     * prompt and the schema both say to name the association, so when the
     * name is "test" or "my hoa" the override has to be louder than either,
     * and it has to sit right next to the name it is about.
     */
    lead.nameProblem
      ? `Association name, exactly as they typed it: "${lead.name}"`
      : `Association: ${lead.name}`,
    lead.nameProblem
      ? `CAUTION: that does not look like a real or complete association name (${lead.nameProblem}). ` +
        `Do not repeat it in the subject or the body, and do not invent a name for them. ` +
        `Write around it: "your association", "your community". ` +
        `Keep the subject generic, like "Your association's insurance review".`
      : null,
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

  if (lead.hasUploadLink) {
    lines.push(
      "",
      "A document link IS being included below your text. Do not ask them to send anything and do not list documents."
    );
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

/**
 * "jake greasley" → "Jake Greasley", anywhere the lead's own name is put in
 * front of them.
 *
 * People fill in forms from a phone without reaching for the shift key, and
 * the greeting repeats whatever they typed. "Hi jake," announces that no
 * person looked at the enquiry before it went out, which is the one
 * impression this email exists to avoid. Both directions are handled: "JAKE"
 * folds to "Jake", because caps-lock is the same habit with the other lock on.
 *
 * Deliberate casing survives. A mixed-case word passes through untouched
 * ("McDonald", "DiAngelo"), and so do two-letter all-caps words ("AJ" is
 * initials, not shouting) and roman-numeral suffixes ("III"). The one thing
 * knowingly flattened is a lowercase particle — "van der berg" comes out
 * "Van Der Berg" — which is the standard CRM trade: raising it is mildly
 * wrong for some Dutch names, and not raising it leaves every no-shift entry
 * broken. Hyphens and apostrophes start a new letter, so "mary-jane o'brien"
 * becomes "Mary-Jane O'Brien".
 */
export function capitalizeName(raw: string | null | undefined): string | null {
  const name = raw?.trim().replace(/\s+/g, " ");
  if (!name) return null;
  const fixPart = (part: string): string => {
    const lower = part.toLowerCase();
    const upper = part.toUpperCase();
    if (lower === upper) return part; // no letters to case
    if (part === lower) return part.charAt(0).toUpperCase() + part.slice(1);
    if (part === upper && part.length > 2 && !/^[IVX]+$/.test(part)) {
      return part.charAt(0) + part.slice(1).toLowerCase();
    }
    return part;
  };
  return name
    .split(" ")
    .map((word) => word.split(/([-'’])/).map(fixPart).join(""))
    .join(" ");
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

/**
 * Word budget for the generated body.
 *
 * `MAX` is what the prompt asks for. `HARD` is where the handler stops trusting
 * it and asks again: models treat a stated range as a target to fill and drift
 * over it, and the first version of this prompt said 80-140 and produced 153.
 *
 * Nothing truncates. Cutting a body off at N words ends an email mid-clause,
 * which is worse than a long one. Over the hard cap the handler regenerates and
 * keeps whichever came back shorter.
 */
export const WORD_BUDGET = { MAX: 80, HARD: 100 } as const;

/** Words in a generated body, counted the way a reader would. */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export interface RenderedReply {
  subject: string;
  text: string;
  html: string;
}

/**
 * The agency signature block, as supplied by the agency.
 *
 * Table-based and inline-styled because that is the only thing Outlook renders
 * predictably, and every fact in it comes from `AGENCY` so the signature cannot
 * drift from the ACORD producer block. The logo is an absolute URL and many
 * clients will block it, which is why the wordmark beside it is real text: with
 * images off the block still reads as a signature rather than a broken frame.
 *
 * The logo is 750x148, so 284 wide is 56 high. The dimensions are stated in both
 * the attributes and the style because Outlook reads only the attributes and
 * ignores `max-width`, while every other client needs the style to let the image
 * shrink on a phone. Getting them to disagree is how a logo ends up stretched.
 */
function signatureHtml(): string {
  const cell =
    'style="padding:1px 8px 1px 0;color:#1A365D;font-weight:700;' +
    'text-transform:uppercase;letter-spacing:0.06em;font-size:11px"';
  const link = 'style="color:#1A1A1A;text-decoration:none"';
  const row = (label: string, inner: string) =>
    `        <tr><td ${cell}>${label}</td><td style="padding:1px 0">${inner}</td></tr>`;

  return `<table style="font-family:Arial,Helvetica,sans-serif;color:#1A1A1A;font-size:14px;line-height:1.4;border-collapse:collapse" border="0" cellspacing="0" cellpadding="0"><tbody>
  <tr>
    <td style="padding:0 20px 0 0;border-right:3px solid #D1B378" valign="top">
      <a href="${AGENCY_FMT.siteHref}" style="text-decoration:none" target="_blank" rel="noopener noreferrer"><img src="${AGENCY_FMT.logoUrl}" height="56" width="284" alt="${escapeHtml(AGENCY_FMT.displayName)}" style="display:block;border:0;outline:none;text-decoration:none;max-width:100%;height:auto"></a>
    </td>
    <td style="padding:0 0 0 20px" valign="top">
      <div style="font-family:'Arial Black','Helvetica Neue',Impact,sans-serif;font-weight:900;font-size:22px;letter-spacing:0.02em;line-height:1;color:#1A365D;text-transform:uppercase;margin:0 0 4px"><span style="color:#D1B378">HOA</span> INSURANCE AGENCY</div>
      <div style="font-family:Arial,Helvetica,sans-serif;font-style:italic;font-weight:600;font-size:12px;color:#9A7D3F;margin:0 0 12px">${escapeHtml(AGENCY.tagline)}</div>
      <table style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#1A1A1A" border="0" cellspacing="0" cellpadding="0"><tbody>
${[
  row("P", `<a href="${AGENCY_FMT.phoneHref}" ${link}>${escapeHtml(AGENCY.phone)}</a>`),
  row("E", `<a href="${AGENCY_FMT.emailHref}" ${link}>${escapeHtml(AGENCY.email)}</a>`),
  row("W", `<a href="${AGENCY_FMT.siteHref}" ${link} target="_blank" rel="noopener noreferrer">${escapeHtml(AGENCY.siteLabel)}</a>`),
  row(
    "A",
    `${escapeHtml(AGENCY.addressLine1)}<br>${escapeHtml(AGENCY_FMT.addressLine2)}`
  ),
].join("\n")}
      </tbody></table>
    </td>
  </tr>
</tbody></table>`;
}

/** The same facts for the plain-text part, where the table cannot go. */
function signatureText(): string[] {
  return [
    AGENCY_FMT.displayName,
    AGENCY.tagline,
    "",
    `P  ${AGENCY.phone}`,
    `E  ${AGENCY.email}`,
    `W  ${AGENCY.siteLabel}`,
    `A  ${AGENCY.addressLine1}`,
    `   ${AGENCY_FMT.addressLine2}`,
  ];
}

/**
 * Wrap the generated body in the greeting, sign-off and signature.
 *
 * The frame is ours, not the model's: the greeting has to use the right first
 * name and the sign-off has to name a real producer. Leaving either to
 * generation is how an email ends up signed by nobody.
 *
 * There is no card, no coloured header bar and no small-print footer. Those
 * were the three things that made this read as a notification from a system
 * rather than an email from a broker, which is the opposite of the point: this
 * is the first thing a board member ever receives from the agency, and it has
 * to look like a person typed it in their mail client. So the body is plain
 * paragraphs on white, set in the same Arial the signature uses, and the only
 * styled thing in the message is the signature itself.
 */
export function renderReply(opts: {
  generated: { subject: string; body: string };
  lead: LeadContext;
  producerName: string;
  /**
   * The lead's document-upload page, if one was minted for them.
   *
   * Rendered by us, never generated. A model asked to include a URL will
   * eventually produce one that is subtly wrong, and a broken link in the first
   * email is worse than no link.
   */
  uploadUrl?: string | null;
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
  /**
   * A suspect association name that made it into the copy anyway is drift,
   * handled the way the tells above are: logged, never spliced out. Matched
   * on word boundaries so a name of "test" does not fire on "latest".
   */
  if (lead.nameProblem && lead.name.trim()) {
    const escaped = lead.name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(`${generated.subject}\n${generated.body}`)) {
      console.warn(
        `[lead-reply] the reply repeats a suspect association name: "${lead.name}"`
      );
    }
  }
  /**
   * Capitalized at the point of use rather than trusted from the context:
   * `renderReply` is the single gate every send passes through, so this is
   * the one place that can guarantee no lowercase form entry reaches the
   * greeting.
   */
  const first = capitalizeName(
    lead.contactFirstName?.trim() || lead.contactName?.trim().split(/\s+/)[0] || null
  );
  const greeting = first ? `Hi ${first},` : "Hello,";

  const paragraphs = generated.body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  /**
   * One sentence and the link, in our words.
   *
   * Deliberately undersold. "Whenever you get a chance" and "send what you have"
   * are doing work: a board member who reads a seven-item list as a precondition
   * sends nothing until they have all seven, which is months. The page says the
   * same thing again per section.
   */
  const uploadUrl = opts.uploadUrl?.trim() || null;
  /**
   * The bare host, for the "(protectmyhoa.com)" beside the link label.
   *
   * `www.` is stripped because nobody reads it as part of a brand, and a failed
   * parse falls back to the empty string rather than throwing: a malformed URL
   * should cost the reassurance, not the email.
   */
  let uploadHost = "";
  if (uploadUrl) {
    try {
      uploadHost = new URL(uploadUrl).host.replace(/^www\./, "");
    } catch {
      uploadHost = "";
    }
  }
  const uploadLine = uploadUrl
    ? `I've put a page together with the documents that would help, so you don't have to hunt through email for them. Send what you have whenever you get a chance:`
    : null;

  const text = [
    greeting,
    "",
    ...paragraphs.flatMap((p) => [p, ""]),
    ...(uploadLine ? [uploadLine, "", uploadUrl as string, ""] : []),
    "Thanks,",
    producerName,
    "",
    ...signatureText(),
  ].join("\n");

  /**
   * `line-height` and `font-family` are set on every paragraph rather than once
   * on a wrapper: Outlook drops inherited styles on block elements inside a
   * table cell, and Gmail strips a `<style>` block entirely.
   */
  const para = (content: string, margin: string) =>
    `  <p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1A1A1A;margin:${margin}">${content}</p>`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:16px 14px;background:#ffffff">
${[
  para(escapeHtml(greeting), "0 0 14px"),
  ...paragraphs.map((p) => para(escapeHtml(p), "0 0 14px")),
  ...(uploadLine && uploadUrl
    ? [
        para(escapeHtml(uploadLine), "0 0 10px"),
        /**
         * Anchor text, not the URL.
         *
         * The first version printed the href verbatim, on the reasoning that a
         * masked link from a stranger reads as phishing and a trustee forwarding
         * this to their board should see where it goes. That reasoning was sound
         * and the result was still wrong: a sixty-character token is its own
         * credibility problem, and three wrapped lines of hex in the middle of a
         * short personal email is the most machine-made thing in it.
         *
         * So the label describes the destination and the domain is named beside
         * it in plain text. Someone deciding whether to trust this can see it
         * goes to the same place as the address in the signature, without
         * reading a token. The text/plain part still carries the full URL,
         * because it has no way to hyperlink anything.
         */
        para(
          `<a href="${escapeHtml(uploadUrl)}" style="color:#1A365D;font-weight:700;text-decoration:underline">Upload your documents</a>` +
            ` <span style="color:#5b6472">(${escapeHtml(uploadHost)})</span>`,
          "0 0 22px"
        ),
      ]
    : []),
  para(`Thanks,<br>${escapeHtml(producerName)}`, "0 0 22px"),
].join("\n")}
${signatureHtml()}
</body></html>`;

  return { subject: generated.subject, text, html };
}
