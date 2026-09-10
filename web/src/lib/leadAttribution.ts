import { ATTRIBUTION_KEYS, cleanAttribution, type LeadAttribution } from "../../../shared/leadSource";
const KEY = "hoa:lead-attribution:v1";
let memory: LeadAttribution | undefined;
/** Last tagged landing in this tab's browsing session. Internal navigation
 * retains it; a new campaign link replaces it. Store only allowed parameters,
 * never a full URL that might contain an upload or other private token. */
export function captureLeadAttribution(): LeadAttribution {
  if (typeof window === "undefined") return {};
  const params = new URLSearchParams(window.location.search);
  const tagged = ATTRIBUTION_KEYS.some(k => k !== "landingPath" && params.get(k)?.trim());
  let saved = memory;
  try { saved = cleanAttribution(JSON.parse(sessionStorage.getItem(KEY) ?? "null")); } catch { /* Memory fallback. */ }
  if (tagged || !saved || !Object.keys(saved).length) {
    saved = cleanAttribution({ ...Object.fromEntries(params), landingPath: window.location.pathname });
    try { sessionStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* Forms still work without storage. */ }
  }
  memory = saved;
  return { ...saved };
}
