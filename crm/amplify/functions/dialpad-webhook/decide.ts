import type {
  CommChannel,
  CommDirection,
  CommState,
} from "../../../src/lib/enums";

/**
 * Dialpad's events → the fields of one `Communication` row.
 *
 * Pure, and the only place that knows Dialpad's vocabulary. Everything
 * downstream reads this module's shapes, so a change at their end is a change
 * here and nowhere else.
 *
 * ── One call, many events ──────────────────────────────────────────────
 * Dialpad does not describe a call once. It describes it continuously:
 * `ringing`, then `connected`, then `hangup`, then — minutes later —
 * `recording`, `call_transcription` and `recap_summary`, each a separate POST
 * carrying the same `call_id`. So every function here returns a PARTIAL row.
 * The handler upserts, and each event fills in what it knows.
 *
 * That is also why `lastEventAt` exists: deliveries are not ordered, and a
 * delayed `ringing` arriving after `hangup` must not overwrite a finished
 * call with an in-progress one.
 */

/** The subset of a Dialpad call event this reads. */
export interface DialpadCallEvent {
  call_id?: number | string;
  state?: string;
  direction?: string;
  external_number?: string;
  internal_number?: string;
  contact?: { name?: string; phone?: string } | null;
  target?: { id?: number | string; email?: string; name?: string } | null;
  date_started?: number;
  date_rang?: number;
  date_connected?: number;
  date_ended?: number;
  event_timestamp?: number;
  duration?: number;
  total_duration?: number;
  was_recorded?: boolean;
  recording_details?: { id?: string; url?: string; recording_type?: string }[];
  transcription_text?: string;
  recap_summary?: string;
  recap_action_items?: string[];
  /** What the CRM stamped on an outbound call it placed. */
  custom_data?: string;
}

/** The subset of a Dialpad SMS event this reads. */
export interface DialpadSmsEvent {
  id?: number | string;
  direction?: string;
  created_date?: number;
  from_number?: string;
  to_number?: string[] | string;
  contact?: { name?: string; phone?: string } | null;
  target?: { id?: number | string; email?: string; name?: string } | null;
  sender_id?: number | string;
  text?: string;
  mms?: boolean;
  message_status?: string;
}

/** What one event says a row should contain. Every field optional but the keys. */
export interface CommunicationDraft {
  channel: CommChannel;
  direction: CommDirection;
  dialpadCallId: string | null;
  dialpadMessageId: string | null;
  externalNumber: string;
  internalNumber: string | null;
  dialpadUserId: string | null;
  targetEmail: string | null;
  contactName: string | null;
  occurredAt: string;
  eventAt: string;
  state: CommState | null;
  durationSeconds: number | null;
  totalDurationSeconds: number | null;
  wasRecorded: boolean | null;
  recordingId: string | null;
  recordingUrl: string | null;
  recapSummary: string | null;
  recapActionItems: string[] | null;
  body: string | null;
  mms: boolean | null;
  messageStatus: string | null;
  /** Account and contact ids the CRM stamped when it placed the call. */
  customData: { accountId?: string; contactId?: string } | null;
}

const iso = (ms: number | undefined | null): string | null =>
  typeof ms === "number" && Number.isFinite(ms) && ms > 0
    ? new Date(ms).toISOString()
    : null;

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim()
    ? v
    : typeof v === "number"
      ? String(v)
      : null;

/** Milliseconds to whole seconds. Dialpad reports both durations in ms. */
const secs = (ms: number | undefined | null): number | null =>
  typeof ms === "number" && Number.isFinite(ms) && ms >= 0
    ? Math.round(ms / 1000)
    : null;

const direction = (raw: string | undefined): CommDirection =>
  raw === "outbound" ? "OUTBOUND" : "INBOUND";

/**
 * States that say something happened to the conversation.
 *
 * Everything else Dialpad sends — `ringing`, `queued`, `parked`, `eavesdrop`,
 * `barge`, the recap and transcription states — is either in-progress or
 * about the call's handling rather than its outcome, and is deliberately
 * absent rather than mapped to something. `recordingState` and the recap
 * fields still ride along on those events; it is only `state` that stays put.
 */
const CALL_STATE: Record<string, CommState> = {
  connected: "CONNECTED",
  hangup: "CONNECTED",
  missed: "MISSED",
  voicemail: "VOICEMAIL",
  voicemail_uploaded: "VOICEMAIL",
  abandoned: "ABANDONED",
};

/**
 * A `hangup` that never connected is not a conversation.
 *
 * Dialpad sends `hangup` for every ended call, connected or not, so taking it
 * at face value would record a caller who gave up while it rang as a
 * completed call — and W7 would count it as service. `date_connected` is what
 * distinguishes them.
 */
function callState(e: DialpadCallEvent): CommState | null {
  const mapped = CALL_STATE[String(e.state ?? "").toLowerCase()];
  if (!mapped) return null;
  if (mapped !== "CONNECTED") return mapped;
  if (e.date_connected) return "CONNECTED";
  // Rang somebody and they did not pick up, versus never rang at all.
  return e.date_rang ? "MISSED" : "ABANDONED";
}

/**
 * What the CRM stamped on a call it placed itself.
 *
 * `custom_data` is free text as far as Dialpad is concerned and comes back
 * exactly as sent, so this is the CRM reading its own note — but it arrives
 * over a public endpoint and is parsed defensively for that reason. A
 * malformed value means the call falls back to matching by number, which is
 * the same path every inbound call takes.
 */
export function parseCustomData(
  raw: string | undefined | null
): { accountId?: string; contactId?: string } | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { accountId, contactId } = parsed as Record<string, unknown>;
    const out: { accountId?: string; contactId?: string } = {};
    if (typeof accountId === "string" && accountId) out.accountId = accountId;
    if (typeof contactId === "string" && contactId) out.contactId = contactId;
    return out.accountId || out.contactId ? out : null;
  } catch {
    return null;
  }
}

/**
 * A call event → a partial row, or `null` if it names no number.
 *
 * A call with no external number cannot be filed under anyone and cannot be
 * triaged either — there is nothing for a person to identify. Dropping it is
 * the only honest outcome.
 */
export function draftFromCall(e: DialpadCallEvent): CommunicationDraft | null {
  const externalNumber = str(e.external_number) ?? str(e.contact?.phone);
  if (!externalNumber) return null;

  const recording = e.recording_details?.find((r) => r?.url) ?? null;
  const state = callState(e);

  return {
    channel: state === "VOICEMAIL" ? "VOICEMAIL" : "CALL",
    direction: direction(e.direction),
    dialpadCallId: str(e.call_id),
    dialpadMessageId: null,
    externalNumber,
    internalNumber: str(e.internal_number),
    dialpadUserId: str(e.target?.id),
    targetEmail: str(e.target?.email),
    // Dialpad's own caller ID. Only used when the CRM cannot identify the
    // number itself — it is what the triage queue shows beside an unknown
    // caller so a person has something to go on.
    contactName: str(e.contact?.name),
    occurredAt:
      iso(e.date_started) ?? iso(e.event_timestamp) ?? new Date().toISOString(),
    // The event's own clock, not this Lambda's: it is what orders two
    // deliveries about the same call, so it must not be the moment we
    // happened to process one.
    eventAt: iso(e.event_timestamp) ?? iso(e.date_started) ?? new Date().toISOString(),
    state,
    durationSeconds: secs(e.duration),
    totalDurationSeconds: secs(e.total_duration),
    wasRecorded: typeof e.was_recorded === "boolean" ? e.was_recorded : null,
    recordingId: str(recording?.id),
    recordingUrl: str(recording?.url),
    recapSummary: str(e.recap_summary),
    recapActionItems: Array.isArray(e.recap_action_items)
      ? e.recap_action_items.filter((i): i is string => typeof i === "string")
      : null,
    // A voicemail's transcription rides on the call event rather than the
    // transcript API, so it is the body of the message it left.
    body: str(e.transcription_text),
    mms: null,
    messageStatus: null,
    customData: parseCustomData(e.custom_data),
  };
}

/**
 * An SMS event → a partial row, or `null` if the customer side is unknowable.
 *
 * Which number is "external" depends on direction, and there is no field that
 * says so: inbound arrives `from_number` → us, outbound goes us →
 * `to_number`. Reading the wrong one files a text under the agency's own
 * number, which would match nothing and queue every message.
 */
export function draftFromSms(e: DialpadSmsEvent): CommunicationDraft | null {
  const dir = direction(e.direction);
  const to = Array.isArray(e.to_number) ? e.to_number[0] : e.to_number;
  const externalNumber =
    dir === "INBOUND" ? str(e.from_number) : (str(to) ?? str(e.contact?.phone));
  const internalNumber = dir === "INBOUND" ? str(to) : str(e.from_number);
  if (!externalNumber) return null;

  const at = iso(e.created_date) ?? new Date().toISOString();
  return {
    channel: "SMS",
    direction: dir,
    dialpadCallId: null,
    dialpadMessageId: str(e.id),
    externalNumber,
    internalNumber,
    dialpadUserId: str(e.target?.id) ?? str(e.sender_id),
    targetEmail: str(e.target?.email),
    contactName: str(e.contact?.name),
    occurredAt: at,
    eventAt: at,
    state: null,
    durationSeconds: null,
    totalDurationSeconds: null,
    wasRecorded: null,
    recordingId: null,
    recordingUrl: null,
    recapSummary: null,
    recapActionItems: null,
    body: str(e.text),
    mms: typeof e.mms === "boolean" ? e.mms : null,
    messageStatus: str(e.message_status),
    customData: null,
  };
}
