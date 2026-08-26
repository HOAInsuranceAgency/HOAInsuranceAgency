import { describe, expect, it } from "vitest";
import {
  draftFromCall,
  draftFromSms,
  parseCustomData,
} from "../../amplify/functions/dialpad-webhook/decide";

/**
 * Dialpad's vocabulary → one row's worth of fields.
 *
 * Two things here are easy to get wrong and expensive to notice. A `hangup`
 * is sent for every ended call, connected or not, so taking it at face value
 * records a caller who gave up while it rang as a completed conversation —
 * and W7 then counts it as service. And an SMS event names both numbers
 * without saying which is the customer's; reading the wrong one files a text
 * under the agency's own line, which matches nothing and queues every message.
 */

const started = Date.UTC(2026, 7, 26, 14, 30, 0);

describe("call state", () => {
  it("is CONNECTED only when the call actually connected", () => {
    const draft = draftFromCall({
      call_id: 1,
      state: "hangup",
      external_number: "+15082332261",
      date_started: started,
      date_rang: started + 1000,
      date_connected: started + 4000,
    });
    expect(draft?.state).toBe("CONNECTED");
  });

  it("is MISSED for a hangup that rang and never connected", () => {
    // Dialpad sends hangup for this too. Trusting it would record a service
    // call that never happened.
    const draft = draftFromCall({
      call_id: 1,
      state: "hangup",
      external_number: "+15082332261",
      date_started: started,
      date_rang: started + 1000,
    });
    expect(draft?.state).toBe("MISSED");
  });

  it("is ABANDONED for a hangup that never even rang", () => {
    const draft = draftFromCall({
      call_id: 1,
      state: "hangup",
      external_number: "+15082332261",
      date_started: started,
    });
    expect(draft?.state).toBe("ABANDONED");
  });

  it("maps the states that speak for themselves", () => {
    const at = (state: string) =>
      draftFromCall({ call_id: 1, state, external_number: "+15082332261" })?.state;
    expect(at("missed")).toBe("MISSED");
    expect(at("voicemail")).toBe("VOICEMAIL");
    expect(at("voicemail_uploaded")).toBe("VOICEMAIL");
  });

  it("leaves state alone for in-progress and handling events", () => {
    // These still carry recap and recording fields, which is why they are
    // processed at all — but none of them says what became of the call.
    for (const state of ["ringing", "calling", "queued", "parked", "eavesdrop", "recap_summary"]) {
      const draft = draftFromCall({ call_id: 1, state, external_number: "+15082332261" });
      expect(draft?.state, state).toBeNull();
    }
  });

  it("files a voicemail as a voicemail, not a call", () => {
    const draft = draftFromCall({
      call_id: 1,
      state: "voicemail",
      external_number: "+15082332261",
      transcription_text: "Hi, it's Marcia, ring me back.",
    });
    expect(draft?.channel).toBe("VOICEMAIL");
    expect(draft?.body).toBe("Hi, it's Marcia, ring me back.");
  });
});

describe("call fields", () => {
  it("converts both durations from milliseconds to seconds", () => {
    const draft = draftFromCall({
      call_id: 1,
      state: "hangup",
      external_number: "+15082332261",
      date_connected: started,
      duration: 185_000,
      total_duration: 197_400,
    });
    expect(draft?.durationSeconds).toBe(185);
    expect(draft?.totalDurationSeconds).toBe(197);
  });

  it("takes the first recording that has a url", () => {
    const draft = draftFromCall({
      call_id: 1,
      state: "recording",
      external_number: "+15082332261",
      recording_details: [
        { id: "r0" },
        { id: "r1", url: "https://dialpad.com/secureblob/callrecording/r1" },
      ],
    });
    expect(draft?.recordingId).toBe("r1");
  });

  it("keeps the event's own clock separate from the call's start", () => {
    // eventAt orders two deliveries about one call, so it must not be the
    // moment we happened to process one.
    const draft = draftFromCall({
      call_id: 1,
      state: "recap_summary",
      external_number: "+15082332261",
      date_started: started,
      event_timestamp: started + 600_000,
    });
    expect(draft?.occurredAt).toBe(new Date(started).toISOString());
    expect(draft?.eventAt).toBe(new Date(started + 600_000).toISOString());
  });

  it("drops a call that names no number at all", () => {
    // It can be filed under nobody and triaged by nobody — there is nothing
    // for a person to identify.
    expect(draftFromCall({ call_id: 1, state: "hangup" })).toBeNull();
  });

  it("falls back to the contact's number when the event omits one", () => {
    const draft = draftFromCall({
      call_id: 1,
      state: "hangup",
      contact: { name: "Marcia Webb", phone: "+15082332261" },
    });
    expect(draft?.externalNumber).toBe("+15082332261");
  });
});

describe("which number is the customer's", () => {
  it("reads from_number on an inbound text", () => {
    const draft = draftFromSms({
      id: 9,
      direction: "inbound",
      from_number: "+15082332261",
      to_number: ["+15085550100"],
      text: "can you send the COI",
    });
    expect(draft?.externalNumber).toBe("+15082332261");
    expect(draft?.internalNumber).toBe("+15085550100");
  });

  it("reads to_number on an outbound text", () => {
    // The mirror image. Getting this backwards files the message under the
    // agency's own line, where it matches nothing.
    const draft = draftFromSms({
      id: 9,
      direction: "outbound",
      from_number: "+15085550100",
      to_number: ["+15082332261"],
      text: "on its way",
    });
    expect(draft?.externalNumber).toBe("+15082332261");
    expect(draft?.internalNumber).toBe("+15085550100");
  });

  it("accepts to_number as a bare string as well as a list", () => {
    const draft = draftFromSms({
      id: 9,
      direction: "outbound",
      to_number: "+15082332261",
    });
    expect(draft?.externalNumber).toBe("+15082332261");
  });

  it("drops a message with no customer number", () => {
    expect(draftFromSms({ id: 9, direction: "inbound" })).toBeNull();
  });
});

describe("custom_data — what the CRM stamped on its own call", () => {
  it("reads back the ids it sent", () => {
    expect(parseCustomData('{"accountId":"a1","contactId":"c1"}')).toEqual({
      accountId: "a1",
      contactId: "c1",
    });
  });

  it("returns null for anything it did not write", () => {
    // It arrives over a public endpoint, so a malformed value falls back to
    // matching by number — the same path every inbound call takes.
    for (const raw of ["", "not json", "[]", "null", '"a string"', "{}", '{"accountId":42}']) {
      expect(parseCustomData(raw), raw).toBeNull();
    }
  });

  it("ignores extra keys rather than passing them through", () => {
    expect(parseCustomData('{"accountId":"a1","isAdmin":true}')).toEqual({ accountId: "a1" });
  });
});
