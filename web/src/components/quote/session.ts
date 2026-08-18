import { FLOW_SIGNATURE, type FormData } from "./schema";
import { states } from "../../data/states";

/* ──────────────────────────────────────────────────────────
   THE PRODUCER
   ────────────────────────────────────────────────────────── */
export type Agent = { name: string; photo: string };

/**
 * The one real person who greets a visitor and is named on their submission.
 *
 * This used to be a roster of eight names and stock headshots, drawn at random
 * per session and re-rolled whenever someone started over — and that invented
 * name was written into the submission email as "Assigned Agent" and into the
 * CRM lead as an assigned-agent note. None of the eight worked here. On a
 * licensed agency's quote form that is not a friendly persona, it is a
 * fabricated licensed representative, and the AI reply this feeds would have
 * been correspondence about insurance signed by someone who does not exist.
 *
 * So: one producer, who is real, using the same photo the contact page shows.
 * If a second ever greets visitors, this becomes a list and the choice is made
 * by something meaningful — the state on the form, a round-robin over actual
 * staff — never by `Math.random()`.
 */
export const PRODUCER: Agent = {
  name: "Brian Cole",
  photo: "/images/brian-cole.jpg",
};

/* ──────────────────────────────────────────────────────────
   PERSISTENCE — survive refresh
   ────────────────────────────────────────────────────────── */
const STORAGE_KEY = "qf:state:v1";
export const THEME_KEY = "qf:theme:v1";

/**
 * No `agent` field, deliberately.
 *
 * It used to be stored, which means live localStorage out there still holds one
 * of the eight invented names. Reading it back would resurrect a fabricated
 * producer on a returning visitor's screen long after the roster was removed,
 * and the flow signature would not catch it — the flow has not changed. The
 * producer is a constant now, so there is nothing session-specific to keep.
 * A stray `agent` key in an old blob is simply ignored.
 */
type PersistedState = {
  stepIndex: number;
  data: FormData;
  role: string | null;
  inputVal: string;
  multiVal: string[];
};

/**
 * What is actually stored: a session, tagged with the flow it was recorded
 * against. `stepIndex` and the `data` keys are both meaningless outside that
 * flow, so the tag is what makes them safe to trust on the way back in.
 */
type StoredSession = PersistedState & { flowSignature: string };

export function loadState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof parsed.stepIndex !== "number" || !parsed.data) {
      return null;
    }
    /**
     * Written by a different version of the flow, so none of it transfers:
     * the index points at a question that has moved or gone, and the answers
     * are keyed by fields the new steps never read. Discarding beats guessing
     * — a returning visitor starts over, which is the honest outcome. Note
     * this also rejects the untagged shape saved before this check existed.
     *
     * No need to remove the key: the next `saveState` overwrites it, so there
     * is nothing orphaned to clean up (which is why this is a tag rather than
     * a bumped `qf:state:v2`, that would have stranded every v1 blob).
     */
    if (parsed.flowSignature !== FLOW_SIGNATURE) return null;
    return {
      stepIndex: parsed.stepIndex,
      data: parsed.data as FormData,
      role: parsed.role ?? null,
      inputVal: typeof parsed.inputVal === "string" ? parsed.inputVal : "",
      multiVal: Array.isArray(parsed.multiVal) ? parsed.multiVal : [],
    };
  } catch {
    return null;
  }
}

export function saveState(s: PersistedState) {
  try {
    const stored: StoredSession = { ...s, flowSignature: FLOW_SIGNATURE };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    /* quota exceeded or private mode — silently ignore */
  }
}

export function clearState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/* ── Smart prefill from URL params ──
   Built from states.ts, not hand-listed. The hardcoded six-state map here meant
   that once the site gained a page per state, arriving from any of the other 45
   prefilled nothing and the visitor had to pick their state manually. */
const STATE_SLUGS: Record<string, string> = Object.fromEntries(
  states.map((s) => [s.slug, s.abbr])
);

export function getPrefillFromUrl(): Partial<{ state: string }> {
  try {
    const params = new URLSearchParams(window.location.search);
    const stateParam = params.get("state");
    if (stateParam) {
      // Direct: ?state=MA
      return { state: stateParam.toUpperCase() };
    }
    // Check referrer for state slug: came from /hoa-insurance-massachusetts
    const ref = document.referrer || "";
    const match = ref.match(/hoa-insurance-([a-z-]+?)(?:\/|$)/);
    if (match) {
      const abbr = STATE_SLUGS[match[1]];
      if (abbr) return { state: abbr };
    }
  } catch {
    /* ignore */
  }
  return {};
}
