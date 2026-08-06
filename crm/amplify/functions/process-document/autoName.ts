import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_CHEAP_MODEL } from "../model";
import { MAX_NAME_CHARS } from "./name";

/**
 * Asking Claude what an uploaded document is.
 *
 * Split from `name.ts` so the browser can import the naming *rules* for the
 * rename box without importing the Anthropic SDK to do it.
 *
 * This runs on every OCR'd upload, so it is pinned to `CLAUDE_CHEAP_MODEL`
 * and shown the first {@link NAME_CONTEXT_CHARS} of extracted text — a page
 * or two, which is where a budget, a loss run and a dec page all announce
 * themselves. The whole call is a fraction of a cent against the Textract
 * bill for the same document.
 */

/** How much OCR text the namer is shown. */
export const NAME_CONTEXT_CHARS = 4_000;

/** The reply that means "I could not tell what this is." */
const UNKNOWN = "UNKNOWN";

const SYSTEM_PROMPT = `You name scanned documents for an HOA insurance agency's CRM. You are given the OCR text of one uploaded document. Reply with a file name for it and nothing else — no preamble, no quotes, no explanation.

Rules:
- Title Case, 3 to 8 words, under ${MAX_NAME_CHARS} characters. No file extension.
- Name what the document is, then whose it is: "2024 Operating Budget — Willow Creek HOA", "GL Loss Runs 2021-2024 — Travelers", "Reserve Study — Harbor Point Condominiums".
- Use only the association names, carriers, policy numbers, form numbers and years that appear in the text. Never invent one, and never guess at a name the text does not give you — a correct generic name beats a specific wrong one.
- The text is raw OCR: it is out of order, mis-spelled and full of headers. Read past that.
- If the text is too thin or too garbled to say what the document is, reply with exactly: ${UNKNOWN}`;

/**
 * A name for a freshly OCR'd document, or `null` to keep the uploaded
 * filename.
 *
 * Null is a first-class answer here, not a failure: the model returns
 * `${UNKNOWN}` on a page of OCR noise, and a two-page fax that yielded
 * nothing readable is better left as `scan_0043.pdf` than renamed to a guess
 * the producer would have to un-guess. The caller cannot tell "no idea" from
 * "the call failed", and does not need to — both mean leave the name alone.
 *
 * Never throws. This runs at the tail of the Textract pipeline, after the
 * extracted text is already committed; a naming failure that propagated would
 * turn a document the agency can search into one marked FAILED.
 */
export async function suggestDocumentName(input: {
  ocrText: string;
  category?: string | null;
  filename: string;
}): Promise<string | null> {
  const text = input.ocrText.trim();
  // Below this there is nothing to name from, and the model would be left
  // inventing from the filename alone — the one thing it is told not to do.
  if (text.length < 40) return null;

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: CLAUDE_CHEAP_MODEL,
      // A name is one short line. This bounds a runaway reply, not the answer.
      max_tokens: 100,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            `Uploaded filename: ${input.filename}`,
            `Category: ${(input.category ?? "unspecified").replace(/_/g, " ").toLowerCase()}`,
            "",
            "OCR text:",
            text.slice(0, NAME_CONTEXT_CHARS),
          ].join("\n"),
        },
      ],
    });

    if (response.stop_reason === "refusal") return null;
    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return null;

    // First line only: the instruction is one line, and anything after it is
    // commentary that would otherwise become part of the name.
    const line = block.text.trim().split("\n")[0] ?? "";
    if (!line || line.trim().toUpperCase() === UNKNOWN) return null;
    return line;
  } catch (err) {
    console.error("Document naming failed; keeping the uploaded name", err);
    return null;
  }
}
