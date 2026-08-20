import { describe, expect, it, vi } from "vitest";
import { decide } from "../../amplify/functions/lead-reply/decide";
import { operationOf } from "../../amplify/functions/lead-upload/dispatch";
import {
  buildPrompt,
  findAiTells,
  renderReply,
  stripDashes,
  systemPrompt,
  type LeadContext,
} from "../../amplify/functions/lead-reply/email";
import {
  PRODUCTION_INTERNAL_MAILBOX,
  PRODUCTION_LEAD_MAILBOX,
  TEST_MAILBOX,
  resolveMailbox,
} from "../../amplify/functions/mailbox";
import { AGENCY, AGENCY_FMT } from "../../../shared/agency";
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

  it("signs off by name, above the signature", () => {
    const { text, html } = renderReply({
      generated,
      lead: lead(),
      producerName: "Brian Cole",
    });
    expect(text).toContain("Thanks,\nBrian Cole");
    expect(html).toContain("Thanks,<br>Brian Cole");
  });

  /**
   * The whole point of this email is that a board member reads it as something
   * a broker typed, so the things that gave it away as machinery are asserted
   * absent rather than left to whoever edits the template next: no card on a
   * grey page, no coloured header bar with the entity name in it, and no
   * small-print block under the signature.
   */
  it("reads as a plain email, not a notification", () => {
    const { html } = renderReply({
      generated,
      lead: lead(),
      producerName: "Brian Cole",
    });
    expect(html).toContain('background:#ffffff');
    expect(html).not.toMatch(/border-radius:\s*10px/);
    expect(html).not.toMatch(/box-shadow/);
    expect(html).not.toMatch(/background:\s*#142a4c/);
    expect(html).not.toMatch(/not a quote/i);
  });

  /** Every fact in the signature comes from `AGENCY`, in both parts. */
  it("carries the agency signature", () => {
    const { text, html } = renderReply({
      generated,
      lead: lead(),
      producerName: "Brian Cole",
    });
    for (const out of [text, html]) {
      expect(out).toContain(AGENCY.phone);
      expect(out).toContain(AGENCY.email);
      expect(out).toContain(AGENCY.siteLabel);
      expect(out).toContain(AGENCY.addressLine1);
      expect(out).toContain(AGENCY.tagline);
    }
    // The logo has to be absolute; a relative path resolves against nothing.
    expect(html).toContain(`src="${AGENCY.site}/logo.png"`);
    // Table-based and inline-styled, because Outlook renders nothing else.
    expect(html).toContain("<table");
    expect(html).not.toContain("<style");
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

  it("declares a charset, so accented names and the strapline survive", () => {
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

/**
 * Which mailbox outbound lead mail uses.
 *
 * Staging sends real email, so this is what keeps a test conversation out of
 * the queue the team works from. The default direction matters more than the
 * addresses: an unrecognised branch mailing the live inbox is invisible until
 * someone notices test threads in Front, whereas a real reply landing at the
 * test address is obvious.
 */
describe("the agency mailbox per branch", () => {
  it("uses the sales inbox for lead mail on main", () => {
    expect(resolveMailbox("lead", "main")).toBe(PRODUCTION_LEAD_MAILBOX);
  });

  it("uses the general inbox for internal reports on main", () => {
    // A digest and a licence deadline are not sales conversations.
    expect(resolveMailbox("internal", "main")).toBe(PRODUCTION_INTERNAL_MAILBOX);
  });

  it("sends everything to the test box on staging", () => {
    expect(resolveMailbox("lead", "staging")).toBe(TEST_MAILBOX);
    expect(resolveMailbox("internal", "staging")).toBe(TEST_MAILBOX);
    expect(TEST_MAILBOX).toBe("jake+testing@protectmyhoa.com");
  });

  /**
   * The direction of the default is the point. An unrecognised branch mailing
   * the live inbox is invisible until someone notices test threads in the
   * queue; a real message at the test address is obvious.
   */
  it("defaults an unknown branch to the test box, never production", () => {
    for (const b of [undefined, "", "sandbox", "feature/foo", "Main", "MAIN", "master"]) {
      expect(resolveMailbox("lead", b)).toBe(TEST_MAILBOX);
      expect(resolveMailbox("internal", b)).toBe(TEST_MAILBOX);
    }
  });

  /**
   * These addresses are spelled out in `functions/mailbox.ts` rather than read
   * from `shared/agency.ts`, because `backend.ts` cannot import outside
   * `amplify/`. A test can import both, so this is what stops the copies
   * drifting apart.
   */
  it("matches the addresses in shared/agency.ts", () => {
    expect(PRODUCTION_LEAD_MAILBOX).toBe(AGENCY_FMT.leadEmailLower);
    expect(PRODUCTION_INTERNAL_MAILBOX).toBe(AGENCY_FMT.emailLower);
  });

  it("keeps every address on the SES-verified domain", () => {
    for (const box of [PRODUCTION_LEAD_MAILBOX, PRODUCTION_INTERNAL_MAILBOX, TEST_MAILBOX]) {
      expect(box).toMatch(/@protectmyhoa\.com$/);
    }
  });
});

/**
 * Which mutation a lead-upload invocation is.
 *
 * This shipped broken: the handler switched on `event.info.fieldName`, Amplify's
 * generated resolver does not send `info`, and every call fell through to
 * "Unknown operation." Nothing in the type system or the build could see it —
 * only a live probe against the deployed endpoint. Hence these.
 */
describe("lead-upload dispatch", () => {
  it("uses info.fieldName when a runtime supplies it", () => {
    expect(operationOf({ info: { fieldName: "requestLeadUpload" }, arguments: {} })).toBe(
      "requestLeadUpload"
    );
    expect(
      operationOf({ info: { fieldName: "closeLeadUploadWindow" }, arguments: {} })
    ).toBe("closeLeadUploadWindow");
  });

  /** The real path today: Amplify sends arguments and no info. */
  it("tells them apart by their arguments when info is absent", () => {
    expect(
      operationOf({ arguments: { uploadToken: "t", filename: "dec.pdf", sizeBytes: 10 } })
    ).toBe("requestLeadUpload");
    expect(operationOf({ arguments: { uploadToken: "t" } })).toBe(
      "closeLeadUploadWindow"
    );
  });

  it("returns null rather than guessing when there is nothing to go on", () => {
    expect(operationOf({})).toBeNull();
    expect(operationOf({ arguments: {} })).toBeNull();
    expect(operationOf({ info: { fieldName: "somethingElse" }, arguments: {} })).toBeNull();
  });

  it("ignores a non-string filename", () => {
    // A malformed call must not be read as an upload request.
    expect(operationOf({ arguments: { uploadToken: "t", filename: 42 } })).toBe(
      "closeLeadUploadWindow"
    );
  });
});

/**
 * The voice rules, and the one that mattered most.
 *
 * The first real reply opened "Hello," because the sweep read
 * `Account.contactFirstName`, which intake never writes: the name lives on the
 * Contact row. Nothing said "no name" — it just quietly addressed a stranger,
 * which is the loudest possible signal that nobody read the enquiry.
 */
describe("sounding like a person wrote it", () => {
  it("greets by first name when there is one", () => {
    const { text, html } = renderReply({
      generated: { subject: "s", body: "b" },
      lead: lead({ contactName: "Pat Alvarez", contactFirstName: "Pat" }),
      producerName: "Brian Cole",
    });
    expect(text.startsWith("Hi Pat,")).toBe(true);
    expect(html).toContain("Hi Pat,");
  });

  it("derives the first name from a full name alone", () => {
    // The Contact row stores one `name`, so this is the common case.
    const { text } = renderReply({
      generated: { subject: "s", body: "b" },
      lead: lead({ contactName: "Jacob Greasley", contactFirstName: null }),
      producerName: "Brian Cole",
    });
    expect(text.startsWith("Hi Jacob,")).toBe(true);
  });

  it("tells the model not to write its own greeting", () => {
    // The frame adds it, using the real name. Both writing one gives two.
    const p = systemPrompt("Brian Cole");
    expect(p).toMatch(/DO NOT WRITE A GREETING/);
    expect(p).toMatch(/added around your text/);
  });

  it("bans the structures that gave the first draft away", () => {
    const p = systemPrompt("Brian Cole");
    // The real reply enumerated ("Two things would move this along. First…"),
    // justified every request, and ran three tidy equal paragraphs.
    expect(p).toMatch(/Do NOT enumerate/);
    expect(p).toMatch(/Do NOT justify each request/);
    expect(p).toMatch(/three tidy paragraphs/);
    expect(p).toMatch(/Hyphenate compound modifiers/);
    // "that gives us plenty of runway, which helps" was in the first draft.
    expect(p).toMatch(/runway/);
  });

  it("keeps dashes out of the frame we write, not just the generated body", () => {
    const { text, html } = renderReply({
      generated: { subject: "s", body: "b" },
      lead: lead(),
      producerName: "Brian Cole",
    });
    // Greeting, sign-off and signature are ours; none of them may introduce one.
    expect(text).not.toMatch(/[—–]/);
    expect(html).not.toMatch(/[—–]/);
  });
});
