import { describe, expect, it, vi } from "vitest";
import { decide } from "../../amplify/functions/lead-reply/decide";
import {
  buildPrompt,
  findAiTells,
  renderReply,
  stripDashes,
  systemPrompt,
  type LeadContext,
} from "../../amplify/functions/lead-reply/email";
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  rejectUpload,
  waitsForExtraction,
} from "../../../shared/leadUpload";

/**
 * The website lead auto-reply.
 *
 * The rule worth holding is that **a reply is never lost**. Every path either
 * sends or names something that must eventually resolve — because the failure
 * mode here is silent and indistinguishable from success: a lead who gets
 * nothing looks exactly like a lead who was never interested.
 */

const NOW = "2026-08-20T15:00:00.000Z";
const EARLIER = "2026-08-20T14:50:00.000Z";
const LATER = "2026-08-20T15:10:00.000Z";

const win = (over: Partial<Parameters<typeof decide>[0]["reply"]> = {}) => ({
  id: "r1",
  accountId: "a1",
  status: "WAITING",
  dueAt: EARLIER,
  uploadCount: 0,
  ...over,
});

const run = (opts: {
  reply?: Partial<Parameters<typeof decide>[0]["reply"]>;
  documents?: { name?: string | null; ocrStatus?: string | null }[];
  account?: { extractionStatus?: string | null };
}) =>
  decide({
    reply: win(opts.reply),
    documents: opts.documents ?? [],
    account: opts.account ?? {},
    now: NOW,
  });

describe("the deadline gate", () => {
  it("waits until the deadline has passed", () => {
    expect(run({ reply: { dueAt: LATER } })).toEqual({
      action: "wait",
      reason: "deadline not reached",
    });
  });

  it("never touches a window that is not waiting", () => {
    // The claim-before-send guard: a second sweep must skip a row mid-send.
    for (const status of ["SENDING", "SENT", "FAILED"]) {
      expect(run({ reply: { status } }).action).toBe("wait");
    }
  });

  it("sends as soon as the deadline passes with nothing uploaded", () => {
    expect(run({})).toEqual({ action: "send", withDocuments: false });
  });
});

describe("waiting on documents", () => {
  it("waits while a readable file is still in OCR", () => {
    const d = run({
      reply: { uploadCount: 1 },
      documents: [{ name: "dec-page.pdf", ocrStatus: "PROCESSING" }],
    });
    expect(d).toEqual({ action: "wait", reason: "1 document(s) still in OCR" });
  });

  it("starts extraction once OCR is done and nothing has asked yet", () => {
    const d = run({
      reply: { uploadCount: 1 },
      documents: [{ name: "dec-page.pdf", ocrStatus: "COMPLETE" }],
      account: { extractionStatus: null },
    });
    expect(d.action).toBe("extract");
  });

  it("waits while extraction runs", () => {
    const d = run({
      reply: { uploadCount: 1 },
      documents: [{ name: "dec-page.pdf", ocrStatus: "COMPLETE" }],
      account: { extractionStatus: "PROCESSING" },
    });
    expect(d).toEqual({ action: "wait", reason: "extraction is PROCESSING" });
  });

  it("sends with document context once extraction completes", () => {
    const d = run({
      reply: { uploadCount: 1 },
      documents: [{ name: "dec-page.pdf", ocrStatus: "COMPLETE" }],
      account: { extractionStatus: "COMPLETE" },
    });
    expect(d).toEqual({ action: "send", withDocuments: true });
  });
});

/**
 * The branches that exist so "always wait for extraction" cannot become
 * "never reply". Each one is a permanent failure with no resolution coming.
 */
describe("a reply is never lost", () => {
  it("sends when a spreadsheet was the only attachment", () => {
    // Textract will never produce text for an .xlsx, so its ocrStatus stays
    // PENDING forever — waiting on it would strand the lead.
    const d = run({
      reply: { uploadCount: 1 },
      documents: [{ name: "2026-budget.xlsx", ocrStatus: "PENDING" }],
    });
    expect(d.action).toBe("send");
    expect(d).toMatchObject({ withDocuments: false });
    expect((d as { note: string }).note).toMatch(/none were readable/i);
  });

  it("sends when every readable file failed OCR", () => {
    const d = run({
      reply: { uploadCount: 2 },
      documents: [
        { name: "scan.pdf", ocrStatus: "FAILED" },
        { name: "photo.jpg", ocrStatus: "FAILED" },
      ],
    });
    expect(d).toMatchObject({ action: "send", withDocuments: false });
    expect((d as { note: string }).note).toMatch(/could not be read/i);
  });

  it("sends form-only when extraction itself fails", () => {
    const d = run({
      reply: { uploadCount: 1 },
      documents: [{ name: "dec-page.pdf", ocrStatus: "COMPLETE" }],
      account: { extractionStatus: "FAILED" },
    });
    expect(d).toMatchObject({ action: "send", withDocuments: false });
    expect((d as { note: string }).note).toMatch(/without document context/i);
  });

  it("treats a mix of read and unreadable files as usable", () => {
    // One failure among several must not discard the ones that worked.
    const d = run({
      reply: { uploadCount: 2 },
      documents: [
        { name: "dec-page.pdf", ocrStatus: "COMPLETE" },
        { name: "blurry.jpg", ocrStatus: "FAILED" },
      ],
      account: { extractionStatus: "COMPLETE" },
    });
    expect(d).toEqual({ action: "send", withDocuments: true });
  });
});

describe("upload limits", () => {
  it("only waits on formats OCR can read", () => {
    expect(waitsForExtraction("dec.pdf")).toBe(true);
    expect(waitsForExtraction("SCAN.TIFF")).toBe(true);
    expect(waitsForExtraction("budget.xlsx")).toBe(false);
    expect(waitsForExtraction("notes")).toBe(false);
  });

  it("names the most basic problem first", () => {
    // A 40MB .mov is both wrong-format and oversized; format is the useful
    // thing to say, since a smaller .mov would still be refused.
    expect(
      rejectUpload({ filename: "walkthrough.mov", sizeBytes: 40e6, alreadyUploaded: 0 })
    ).toBe("type");
    expect(
      rejectUpload({ filename: "packet.pdf", sizeBytes: MAX_FILE_BYTES + 1, alreadyUploaded: 0 })
    ).toBe("size");
    expect(
      rejectUpload({ filename: "packet.pdf", sizeBytes: 1000, alreadyUploaded: MAX_FILES })
    ).toBe("count");
    expect(rejectUpload({ filename: "  ", alreadyUploaded: 0 })).toBe("name");
  });

  it("accepts what the panel offers", () => {
    for (const name of ["dec.pdf", "photo.jpg", "budget.xls", "docs.docx"]) {
      expect(rejectUpload({ filename: name, sizeBytes: 1000, alreadyUploaded: 0 })).toBeNull();
    }
  });

  it("allows a size it was not told", () => {
    // The browser always sends one; a hand-rolled caller may not, and refusing
    // on absence would block a legitimate upload over a missing field.
    expect(rejectUpload({ filename: "dec.pdf", alreadyUploaded: 0 })).toBeNull();
  });
});

const lead = (over: Partial<LeadContext> = {}): LeadContext => ({
  name: "Robin Hollow Condominium",
  contactName: "Pat Alvarez",
  contactFirstName: "Pat",
  state: "MA",
  city: "Marlborough",
  unitCount: 48,
  notes: "Role: board. Lines: Commercial Property, D&O.",
  source: "website",
  documentNames: [],
  ...over,
});

describe("the prompt", () => {
  it("passes on what the lead told us", () => {
    const p = buildPrompt(lead());
    expect(p).toContain("Robin Hollow Condominium");
    expect(p).toContain("Marlborough, MA");
    expect(p).toContain("Units: 48");
    expect(p).toContain("Lines: Commercial Property, D&O");
  });

  it("offers extracted values as what the document shows", () => {
    const p = buildPrompt(
      lead({
        documentNames: ["dec-page.pdf"],
        extracted: { currentCarrier: "Travelers", masterPolicyExpiration: "2026-09-01" },
      })
    );
    expect(p).toContain("Current carrier: Travelers");
    expect(p).toContain("Master policy expiration: 2026-09-01");
    expect(p).toMatch(/what their document shows/i);
  });

  /** The model must not narrate a document it could not read. */
  it("says so when attachments produced nothing", () => {
    const p = buildPrompt(lead({ documentNames: ["blurry.jpg"], extracted: null }));
    expect(p).toMatch(/do not refer to their contents/i);
  });

  it("drops empty extracted fields rather than offering blanks", () => {
    const p = buildPrompt(
      lead({ documentNames: ["d.pdf"], extracted: { currentCarrier: "", units: "48" } })
    );
    expect(p).not.toContain("Current carrier:");
    expect(p).toContain("Units: 48");
  });
});

describe("the rendered email", () => {
  const generated = {
    subject: "Robin Hollow Condominium — your insurance review",
    body: "First paragraph about the association.\n\nSecond paragraph asking for the dec page.",
  };

  it("frames the body with a greeting and a real signature", () => {
    const { text, html } = renderReply({
      generated,
      lead: lead(),
      producerName: "Brian Cole",
    });
    expect(text).toContain("Hi Pat,");
    expect(text).toContain("Brian Cole");
    expect(html).toContain("Brian Cole");
    // Both paragraphs survive the plain-text → HTML split.
    expect(html).toContain("First paragraph");
    expect(html).toContain("Second paragraph");
  });

  /**
   * The one line that is never left to generation: an email that reads as
   * confirmation of coverage is the misunderstanding worth preventing outright.
   */
  it("always carries the not-a-quote disclosure", () => {
    const { text, html } = renderReply({
      generated,
      lead: lead(),
      producerName: "Brian Cole",
    });
    for (const out of [text, html]) {
      expect(out).toMatch(/not a quote/i);
      expect(out).toMatch(/nothing is bound/i);
    }
  });

  it("falls back to a plain greeting with no name", () => {
    const { text } = renderReply({
      generated,
      lead: lead({ contactFirstName: null, contactName: null }),
      producerName: "Brian Cole",
    });
    expect(text.startsWith("Hello,")).toBe(true);
  });

  it("escapes markup in a generated body", () => {
    const { html } = renderReply({
      generated: { ...generated, body: "<script>alert(1)</script>" },
      lead: lead(),
      producerName: "Brian Cole",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("declares a charset, so the em dashes in the disclosure survive", () => {
    const { html } = renderReply({ generated, lead: lead(), producerName: "Brian Cole" });
    expect(html).toContain('<meta charset="utf-8">');
  });
});

/**
 * Sounding human is a requirement, not a preference, so the dash rule is
 * enforced in code rather than asked for. Models reliably ignore "never use an
 * em dash", and it is the one tell that can be substituted without touching
 * meaning — every em dash in this position is a parenthetical, and a comma
 * reads correctly in its place.
 */
describe("no dashes reach the lead", () => {
  it("replaces a spaced em dash with a comma, without doubling the space", () => {
    expect(stripDashes("your program — the master policy — is due")).toBe(
      "your program, the master policy, is due"
    );
  });

  it("handles unspaced dashes, en dashes and double hyphens", () => {
    expect(stripDashes("48-unit—we can help")).toBe("48-unit, we can help");
    expect(stripDashes("2026–2027 term")).toBe("2026, 2027 term");
    expect(stripDashes("one thing -- then another")).toBe("one thing, then another");
  });

  it("leaves hyphens in real words alone", () => {
    // A hyphenated compound is not the habit being removed.
    expect(stripDashes("a 48-unit self-managed association")).toBe(
      "a 48-unit self-managed association"
    );
  });

  it("does not leave a doubled comma behind", () => {
    expect(stripDashes("the policy, — which expires soon — needs review")).not.toMatch(/,\s*,/);
  });

  it("strips dashes from the subject and body of a real send", () => {
    const { subject, text, html } = renderReply({
      generated: {
        subject: "Robin Hollow — insurance review",
        body: "Your program — all six lines — is up in September.",
      },
      lead: lead(),
      producerName: "Brian Cole",
    });
    for (const out of [subject, text, html]) {
      expect(out).not.toMatch(/[—–]/);
    }
    expect(subject).toBe("Robin Hollow, insurance review");
  });

  /** Including the parts we write, not just the parts the model writes. */
  it("has no dash in the frame we control", () => {
    const { text, html } = renderReply({
      generated: { subject: "Plain subject", body: "Plain body." },
      lead: lead(),
      producerName: "Brian Cole",
    });
    expect(text).not.toMatch(/[—–]/);
    expect(html).not.toMatch(/[—–]/);
  });
});

describe("other AI tells", () => {
  /**
   * Detected and logged, never spliced out. Cutting a phrase from finished
   * prose leaves a worse sentence than the tell did, and a model that ignored
   * the instruction usually did so structurally.
   */
  it("finds the phrasings the prompt forbids", () => {
    expect(findAiTells("I hope this email finds you well.")).toContain(
      "i hope this email finds you well"
    );
    expect(findAiTells("Feel free to reach out.")).toContain("feel free to");
    expect(findAiTells("We leverage a seamless process.")).toEqual(
      expect.arrayContaining(["leverage", "seamless"])
    );
  });

  it("passes copy that reads like a person wrote it", () => {
    expect(
      findAiTells(
        "Thanks for sending this over. I've got your 48 units in Marlborough and " +
          "the D&O question. I'll pull your current program apart this week and " +
          "come back with what I find. If you can dig out the declaration page, " +
          "that saves me a step."
      )
    ).toEqual([]);
  });

  it("warns rather than mangling when the model drifts", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { text } = renderReply({
      generated: { subject: "Review", body: "I wanted to reach out about your policy." },
      lead: lead(),
      producerName: "Brian Cole",
    });
    // The sentence is delivered intact; the drift is reported to the log.
    expect(text).toContain("I wanted to reach out");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("i wanted to reach out"));
    warn.mockRestore();
  });
});

describe("the prompt states the voice rules", () => {
  it("bans the dash and the usual openers and vocabulary", () => {
    const p = systemPrompt("Brian Cole");
    expect(p).toMatch(/NEVER use an em dash/);
    expect(p).toMatch(/i hope this email finds you well/i);
    expect(p).toMatch(/delve|leverage|seamless/);
    expect(p).toMatch(/No exclamation marks/);
  });

  /** A prompt that uses the character while banning it undercuts the rule. */
  it("contains no em dash itself", () => {
    expect(systemPrompt("Brian Cole")).not.toMatch(/[—–]/);
  });

  it("names the real producer", () => {
    expect(systemPrompt("Brian Cole")).toContain("Brian Cole");
  });
});
