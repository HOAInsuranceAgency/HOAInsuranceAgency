import { describe, expect, it } from "vitest";
import { matchesQueuedEmail } from "../../amplify/functions/communications/emailReview";
import type { FrontMessage } from "../../amplify/functions/communications/providers";

const queued = {
  recipient: "prospect@example.com",
  subject: "Your association's review",
  text: "Hi Pat,\n\nI'll review the documents for your association.",
  emailIdentity: {
    frontId: "tea_jake",
    channelId: "cha_jake",
    senderEmail: "jake@protectmyhoa.com",
    signatureId: "sig_jake",
    signatureMode: "FRONT" as const,
  },
};

const delivered = (patch: Partial<FrontMessage> = {}): FrontMessage => ({
  id: "msg_initial",
  created_at: 123,
  is_inbound: false,
  is_draft: false,
  subject: queued.subject,
  text: `${queued.text}\n\nJake Greasley\njake@protectmyhoa.com`,
  author: { id: "tea_jake" },
  recipients: [
    { role: "from", handle: "jake@protectmyhoa.com" },
    { role: "to", handle: "prospect@example.com" },
  ],
  ...patch,
});

describe("manual confirmation of a Front-signed initial email", () => {
  it("matches the captured producer and full unsigned body with an appended signature", () => {
    expect(matchesQueuedEmail(delivered(), queued)).toBe(true);
  });

  it("allows line-ending conversion and address casing without rewriting message prose", () => {
    expect(matchesQueuedEmail(delivered({
      subject: ` ${queued.subject} `,
      text: delivered().text!.replace(/\n/g, "\r\n"),
      recipients: [
        { role: "from", handle: "JAKE@PROTECTMYHOA.COM" },
        { role: "to", handle: "PROSPECT@EXAMPLE.COM" },
      ],
    }), queued)).toBe(true);
  });

  it.each([
    ["another producer", { author: { id: "tea_brian" } }],
    ["missing author", { author: undefined }],
    ["shared mailbox", { recipients: [{ role: "from", handle: "sales@protectmyhoa.com" }, { role: "to", handle: queued.recipient }] }],
    ["missing From address", { recipients: [{ role: "to", handle: queued.recipient }] }],
    ["multiple From addresses", { recipients: [...delivered().recipients!, { role: "from", handle: "brian@protectmyhoa.com" }] }],
    ["wrong recipient", { recipients: [{ role: "from", handle: queued.emailIdentity.senderEmail }, { role: "to", handle: "someoneelse@example.com" }] }],
    ["inbound message", { is_inbound: true }],
    ["draft", { is_draft: true }],
    ["unknown draft status", { is_draft: undefined }],
    ["changed subject", { subject: "Another review" }],
    ["reply-prefix subject", { subject: `Re: ${queued.subject}` }],
    ["missing subject", { subject: undefined }],
    ["missing body", { text: undefined }],
    ["edited body", { text: delivered().text!.replace("review the documents", "send a quote") }],
    ["partial original body", { text: "Hi Pat,\n\nJake Greasley" }],
    ["body followed immediately by text", { text: `${queued.text}Extra words\nJake Greasley` }],
    ["no signature", { text: queued.text }],
    ["blank signature", { text: `${queued.text}\n \n` }],
  ] satisfies [string, Partial<FrontMessage>][])('rejects %s', (_label, patch) => {
    expect(matchesQueuedEmail(delivered(patch), queued)).toBe(false);
  });

  it.each([undefined, "", " \r\n "])("rejects a missing or empty queued body (%s)", text => {
    expect(matchesQueuedEmail(delivered(), { ...queued, text })).toBe(false);
  });

  it("requires persisted channel and signature evidence", () => {
    for (const key of ["frontId", "channelId", "senderEmail", "signatureId"] as const) {
      expect(matchesQueuedEmail(delivered(), { ...queued, emailIdentity: { ...queued.emailIdentity, [key]: "" } }), key).toBe(false);
    }
  });
});

describe("manual confirmation of legacy email operations", () => {
  const legacy = { recipient: queued.recipient, text: "Hi Pat,\n\nThanks,\nBrian Cole" };

  it("still accepts an exact complete body without requiring new sender metadata", () => {
    expect(matchesQueuedEmail(delivered({ text: legacy.text, author: undefined, is_draft: undefined, subject: undefined }), legacy)).toBe(true);
  });

  it("does not apply the signature-prefix exception to legacy operations", () => {
    expect(matchesQueuedEmail(delivered({ text: `${legacy.text}\n\nOther signature` }), legacy)).toBe(false);
  });

  it("retains exact body comparison including internal line endings", () => {
    expect(matchesQueuedEmail(delivered({ text: legacy.text.replace(/\n/g, "\r\n") }), legacy)).toBe(false);
  });
});
