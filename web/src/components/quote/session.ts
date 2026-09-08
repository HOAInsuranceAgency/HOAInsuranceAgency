import { FLOW_SIGNATURE, type FormData } from "./schema";
import { states } from "../../data/states";

export type Agent = { name: string; photo: string };

/** Quote-form greeter; Brian's licensed-producer title appears on /contact. */
export const PRODUCER: Agent = {
  name: "Brian Cole",
  photo: "/images/brian-cole.jpg",
};

/* ──────────────────────────────────────────────────────────
   PERSISTENCE — survive refresh
   ────────────────────────────────────────────────────────── */
const STORAGE_KEY = "qf:state:v1";
export const THEME_KEY = "qf:theme:v1";

/** Producer is constant and old persisted `agent` keys are ignored. */
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
    /** Reject stale or untagged flow state. */
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
