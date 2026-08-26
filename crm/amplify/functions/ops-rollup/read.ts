/**
 * "The read" — two or three sentences at the top of the email saying what the
 * morning actually amounts to.
 *
 * Everything else in this rollup is a list. Lists are complete and lists are
 * dumb: they cannot say that the coverage gap on one association matters more
 * than the eleven overdue invoices under it, or that a good production month
 * is being carried entirely by one deal that has not been billed yet. That
 * judgement is what an owner reads a summary for, and it is the one part of
 * this job a model does better than a template.
 *
 * ── The rule that makes it safe to print ──
 *
 * A language model writing about money will, sooner or later, produce a
 * plausible number that is not in the data. So this module does not trust it
 * to be careful: it builds the set of figures the payload actually contains,
 * and every number in the returned prose is checked against that set. One
 * unverifiable figure and the whole paragraph is dropped — the email still
 * sends, just without a read.
 *
 * That is the right failure direction. A missing paragraph costs nothing; a
 * confidently wrong premium figure at the top of the owner's morning email
 * costs the entire report its credibility, and it would take months to notice.
 *
 * ── Why it can never break the send ──
 *
 * Every path here returns `null` rather than throwing. A model outage, a
 * missing key, a timeout, a refusal, a bad shape — all of them degrade to the
 * email that would have been sent anyway. This section is an enhancement, and
 * an enhancement that can take down the report is a liability.
 */

import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODEL } from "../model";

/** Hard ceiling on the call. The email is due at 07:20; it does not wait. */
const TIMEOUT_MS = 45_000;

/**
 * Far more than three sentences need, and that is the point.
 *
 * `max_tokens` is the ceiling on the model's REASONING as well as its prose,
 * and the reasoning is most of the spend here: deciding which of eleven
 * findings leads is the work, and the paragraph is only what falls out of it.
 * Sized for the paragraph alone (700 was the first attempt) roughly two runs
 * in three came back truncated and were thrown away — the summary looked
 * flaky when it was simply starved.
 *
 * Billing is on tokens actually produced, so the headroom costs nothing on a
 * run that does not need it, and the prompt is what holds the prose short.
 */
const MAX_TOKENS = 3000;

const SYSTEM_PROMPT = `You write the opening paragraph of a daily operations email for the owner of a small commercial insurance agency. He is also a producing agent, and a few other producers work under him. The agency writes habitational business — condominium and homeowner association master policies. Sales cycles run 30 to 90 days, every carrier submission is manual, and the boards that buy are volunteer committees that meet monthly.

Write two or three sentences. Plain, direct, and specific — the way a good operations lead speaks to a principal who already knows the business. No greeting, no sign-off, no headings, no bullet points, no bold.

Every item you might mention is ALREADY LISTED IN FULL directly beneath your paragraph, with its own figures. Repeating a row back is wasted space. Your job is the sentence the list cannot write: what this morning amounts to, which one thing to do first, and whether anything here is worse than it looks.

What earns the space, in this order:
1. Anything where coverage has lapsed, is about to, or a client is at risk of being cancelled. This outranks every financial figure.
2. The one thing that most changes what he should do today — and say what to do, not what the row says.
3. Where the month actually stands, but only if it is genuinely notable — well ahead, well behind, or carried by a single deal that is not yet billed or collected.

Name at most two associations. If the strongest thing you can say is that two unrelated problems share a cause, or that a good month rests on one unbilled policy, say that instead of listing anything.

Rules you must not break:
- Every number you write must appear verbatim in the JSON you are given. Never calculate, never total, never estimate, never round to a nicer figure. If you want to say something the numbers do not support, say it without a number or leave it out.
- Never invent an association name, a person's name or a carrier. Use only names present in the JSON.
- Each row in exposed, closing and money stands alone. Never say or imply that two rows concern the same association unless they carry the same "subject" string, and never merge two rows into one claim.
- "standingCounts" are agency-wide totals per problem type with NO association attached. You may say how many there are. You must never attribute one to a named association, and you must never use one to characterise a row that names an association.
- Never state or imply why a person did or did not do something. The data records CRM writes, not phone calls, carrier emails, inspections or board meetings, and it cannot see effort.
- Never speculate about causes, and never give advice that the figures do not directly support.
- If the day is genuinely unremarkable, say so in one sentence and stop. That is a useful thing to have said, and padding it is worse than brevity.
- Finish every sentence. Never trail off.`;

export interface ReadPayload {
  covering: string;
  exposed: { subject: string; clause: string; amount: number | null }[];
  closing: { subject: string; clause: string; amount: number | null }[];
  money: { subject: string; clause: string; amount: number | null }[];
  /** Agency-wide counts per problem type. No association is attached to these. */
  standingCounts: Record<string, number>;
  done: Record<string, unknown>;
  progress: Record<string, unknown>;
}

/**
 * Every figure the payload contains, in the forms prose might spell it.
 *
 * A model writing about `41200` will usually write `41,200`, sometimes
 * `$41,200`, and a rate of `0.18` reads as `18%`. All of those are the same
 * fact, so all of them are allowed — and nothing else is.
 */
export function allowedNumbers(payload: unknown): Set<string> {
  const out = new Set<string>();
  const add = (n: number) => {
    if (!Number.isFinite(n)) return;
    out.add(String(n));
    out.add(String(Math.round(n)));
    out.add(String(Math.abs(Math.round(n))));
    // Rates arrive as fractions and are read as percentages.
    out.add(String(Math.round(Math.abs(n) * 100)));
    out.add(String(Math.round(Math.abs(n) * 1000) / 10));
  };
  const walk = (v: unknown) => {
    if (typeof v === "number") add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
    else if (typeof v === "string") {
      // Figures already composed into a clause ("expired 4d ago") count too.
      for (const m of v.matchAll(/\d+(?:\.\d+)?/g)) add(Number(m[0]));
    }
  };
  walk(payload);
  return out;
}

/** Every number the prose asserts, normalised for comparison. */
export function citedNumbers(text: string): string[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => {
    const raw = m[0].replace(/,/g, "");
    const n = Number(raw);
    return Number.isFinite(n) ? String(n) : raw;
  });
}

/**
 * Whether every figure in the prose is one the data actually contains.
 *
 * Ordinals and small counts are NOT waived. A model that writes "3 renewals"
 * when the data says 2 is exactly the failure this guards against, and those
 * small numbers are the ones a reader is least likely to check.
 */
export function verifyNumbers(
  text: string,
  allowed: ReadonlySet<string>
): { ok: true } | { ok: false; offending: string } {
  for (const n of citedNumbers(text)) {
    if (!allowed.has(n)) return { ok: false, offending: n };
  }
  return { ok: true };
}

/** Prose the model should never have produced, regardless of its figures. */
const BANNED = [
  /\bshould have\b/i,
  /\bfailed to\b/i,
  /\bnobody (?:bothered|cared)\b/i,
  /^\s*(?:hi|hello|good morning|dear)\b/i,
];

export interface ReadResult {
  text: string | null;
  /** Why there is no read, for the count-only log. */
  skipped: "no-key" | "error" | "unverified" | "banned" | "empty" | "truncated" | null;
}

/**
 * The paragraph, or null and a reason.
 *
 * Never throws.
 */
export async function writeRead(payload: ReadPayload): Promise<ReadResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { text: null, skipped: "no-key" };

  try {
    const anthropic = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 1 });
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Here is this morning's data for the period covering ${payload.covering}. Write the opening paragraph.\n\n${JSON.stringify(payload, null, 1)}`,
        },
      ],
    });

    if (response.stop_reason === "refusal") return { text: null, skipped: "error" };
    // A paragraph that ran out of room stops mid-clause. At the top of the
    // owner's morning email that reads as a broken system, and the rows below
    // already carry everything it was going to say — so it is dropped rather
    // than printed half-finished.
    if (response.stop_reason === "max_tokens") return { text: null, skipped: "truncated" };
    const block = response.content.find((b) => b.type === "text");
    const text = block && block.type === "text" ? block.text.trim() : "";
    if (!text) return { text: null, skipped: "empty" };

    const verdict = verifyNumbers(text, allowedNumbers(payload));
    if (!verdict.ok) {
      // Logged without the prose: the point is that it was wrong, and the
      // wrong sentence is not something to keep a copy of in CloudWatch.
      console.warn(
        "ops-rollup: read dropped, unverifiable figure",
        JSON.stringify({ offending: verdict.offending })
      );
      return { text: null, skipped: "unverified" };
    }
    if (BANNED.some((re) => re.test(text))) return { text: null, skipped: "banned" };

    return { text, skipped: null };
  } catch (err) {
    // A model outage must not cost the agency its morning report.
    console.error("ops-rollup: read unavailable", err);
    return { text: null, skipped: "error" };
  }
}
