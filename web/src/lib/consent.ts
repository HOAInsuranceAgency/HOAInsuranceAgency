/**
 * Visitor privacy choices: what is stored, and how it is read back.
 *
 * Model (chosen 2026-11-12): US state privacy laws are opt-out laws, so
 *
 * - Performance analytics (Google Analytics 4) runs by default and stops if
 *   the visitor declines it.
 * - Marketing (Google Ads) also runs by default, EXCEPT for visitors on
 *   Pacific time (California, plus Washington, Oregon and Nevada), where it
 *   waits for consent. California's wiretap law (CIPA) is where most
 *   ad-pixel lawsuits are filed. The site is static, so the browser's time
 *   zone is the location signal: nothing is sent anywhere to work it out.
 * - Session insights (Microsoft Clarity, session recording) always waits for
 *   the visitor to allow it.
 * - Accept and decline are equally easy (California's symmetry rule).
 * - A Global Privacy Control signal is honoured as an opt-out of marketing
 *   (sale, sharing and targeted advertising), as California, Colorado,
 *   Connecticut, Texas, Oregon, Montana, New Jersey and others require.
 * - Choices can be changed at any time from "Cookie Preferences".
 *
 * The choice is stored on the visitor's own device in a first-party cookie
 * (`pmh_consent`) for 12 months. Changing CONSENT_VERSION asks everyone again,
 * which is what to do when a new kind of tag is added.
 * If the browser cannot retain an opt-out, all optional tags stay disabled.
 */

export const CONSENT_VERSION = 2;
export const CONSENT_COOKIE = "pmh_consent";
const MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const NO_CONSENT: ConsentChoice = { analytics: false, insights: false, marketing: false };
let storageAvailable: boolean | undefined;

export interface ConsentChoice {
  /** Google Analytics 4. On unless declined. */
  analytics: boolean;
  /** Microsoft Clarity session insights. Only with consent. */
  insights: boolean;
  /** Google Ads; the "sale/sharing" and targeted-advertising opt-out. Only with consent. */
  marketing: boolean;
}

export interface ConsentState extends ConsentChoice {
  /** Version of the choices offered when this was saved. */
  v: number;
  /** Whether a Global Privacy Control signal was present when saved. */
  gpc: boolean;
  /** ISO timestamp of the choice. */
  at: string;
  /** How the choice was made. */
  source: "banner" | "settings";
}

/** Time zones treated as California for the marketing default. */
const CONSENT_FIRST_TIME_ZONES = new Set(["America/Los_Angeles", "US/Pacific", "PST8PDT"]);

/** True for visitors whose browser is on Pacific time (see the note above). */
export function consentFirstRegion(): boolean {
  try {
    return CONSENT_FIRST_TIME_ZONES.has(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return false;
  }
}

/** What applies before the visitor has chosen anything. */
export function defaultChoice(): ConsentChoice {
  return {
    analytics: true,
    insights: false,
    marketing: !consentFirstRegion() && !gpcEnabled(),
  };
}

/** True when the browser sends a Global Privacy Control signal. */
export function gpcEnabled(): boolean {
  if (typeof navigator === "undefined") return false;
  return (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
}

/** Defaults may enable tags only if this browser can retain an opt-out. */
export function consentStorageAvailable(): boolean {
  if (storageAvailable !== undefined) return storageAvailable;
  if (typeof document === "undefined" || typeof window === "undefined") return false;
  // Concurrent tabs must not overwrite or delete each other's storage probes.
  const probe = `${CONSENT_COOKIE}_check_${Math.random().toString(36).slice(2)}`;
  const value = `${Date.now()}-${Math.random()}`;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  try {
    document.cookie = `${probe}=${value}; Max-Age=60; Path=/; SameSite=Lax${secure}`;
    storageAvailable = document.cookie.split("; ").includes(`${probe}=${value}`);
    document.cookie = `${probe}=; Max-Age=0; Path=/; SameSite=Lax${secure}`;
  } catch {
    storageAvailable = false;
  }
  return storageAvailable;
}

/** The saved choice, or null when the visitor has not chosen (or it expired). */
export function readConsent(): ConsentState | null {
  if (!consentStorageAvailable()) return null;
  let raw: string | undefined;
  try {
    raw = document.cookie
      .split("; ")
      .find((part) => part.startsWith(`${CONSENT_COOKIE}=`))
      ?.slice(CONSENT_COOKIE.length + 1);
  } catch {
    storageAvailable = false;
    return null;
  }
  if (!raw) return null;
  try {
    const value = JSON.parse(decodeURIComponent(raw)) as Partial<ConsentState>;
    if (value.v !== CONSENT_VERSION || typeof value.at !== "string") return null;
    const age = Date.now() - Date.parse(value.at);
    if (!Number.isFinite(age) || age > MAX_AGE_SECONDS * 1000) return null;
    return {
      v: CONSENT_VERSION,
      analytics: value.analytics === true,
      insights: value.insights === true,
      // A GPC signal always wins over an earlier opt-in to marketing.
      marketing: value.marketing === true && !gpcEnabled(),
      gpc: gpcEnabled(),
      at: value.at,
      source: value.source === "settings" ? "settings" : "banner",
    };
  } catch {
    return null;
  }
}

/** The choice in effect now: the saved one, or the default before any choice. */
export function effectiveConsent(): ConsentChoice {
  if (!consentStorageAvailable()) return { ...NO_CONSENT };
  const saved = readConsent();
  return saved ?? (consentStorageAvailable() ? defaultChoice() : { ...NO_CONSENT });
}

/** Recheck browser storage when another tab or a resumed page changes consent. */
export function refreshConsent(): ConsentChoice {
  // Once storage fails, stay closed for this page until an explicit save
  // succeeds. A polling probe must not undo an unsuccessful opt-out.
  if (storageAvailable !== false) storageAvailable = undefined;
  return effectiveConsent();
}

/** Verify that the preference was retained; unavailable storage fails closed. */
export function saveConsent(choice: ConsentChoice, source: ConsentState["source"]): { state: ConsentState; persisted: boolean } {
  const gpc = gpcEnabled();
  const state: ConsentState = {
    v: CONSENT_VERSION,
    analytics: choice.analytics,
    insights: choice.insights,
    marketing: choice.marketing && !gpc,
    gpc,
    at: new Date().toISOString(),
    source,
  };
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  const encoded = encodeURIComponent(JSON.stringify(state));
  try {
    document.cookie = `${CONSENT_COOKIE}=${encoded}; Max-Age=${MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure}`;
    storageAvailable = document.cookie.split("; ").includes(`${CONSENT_COOKIE}=${encoded}`);
  } catch {
    storageAvailable = false;
  }
  return {
    state: storageAvailable ? state : { ...state, ...NO_CONSENT },
    persisted: storageAvailable,
  };
}
