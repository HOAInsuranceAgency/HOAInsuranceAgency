/**
 * Carry the address someone typed on a hero form into the quote wizard.
 *
 * ## Why sessionStorage and not the URL
 *
 * A property address is personal data. Putting it in `/quote?address=…` would
 * put it in browser history, in the `Referer` of anything the quote page
 * requests, in server logs, and in the `page_location` that GA4, Google Ads and
 * Clarity all report. That is exactly the leak the hero field was stripped of
 * its `name` to prevent, and this exists so carrying the value forward does not
 * reintroduce it. sessionStorage never leaves the tab.
 *
 * ## One shot
 *
 * `takeHandoff` clears as it reads. An address typed twenty minutes ago on the
 * homepage should not silently appear in a wizard someone started fresh, and a
 * value that survives being consumed is a value that shows up somewhere nobody
 * expects.
 */

const KEY = "qf:address-handoff:v1";

/**
 * How long a handed-over address stays usable.
 *
 * sessionStorage already dies with the tab, so this only guards the case of
 * someone landing on the homepage, wandering the site, and reaching /quote much
 * later. Long enough to read a page or two first; short enough that the address
 * still reflects what they came in for.
 */
const TTL_MS = 30 * 60 * 1000;

/** The wizard's own field names, so the payload drops straight into its answers. */
export interface HandedAddress {
  propertyAddress: string;
  city?: string;
  state?: string;
  zip?: string;
}

interface Stored extends HandedAddress {
  at: number;
}

/** Called by a hero form as it submits. Failure is silently ignored. */
export function stashHandoff(address: HandedAddress): void {
  if (!address.propertyAddress?.trim()) return;
  try {
    const payload: Stored = { ...address, at: Date.now() };
    sessionStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    // Private mode, or storage full. The wizard simply asks for the address,
    // which is what it did before any of this existed.
  }
}

/** Read and clear. Returns null when there is nothing usable to hand over. */
export function takeHandoff(): HandedAddress | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (typeof parsed.propertyAddress !== "string" || !parsed.propertyAddress.trim()) {
      return null;
    }
    if (typeof parsed.at !== "number" || Date.now() - parsed.at > TTL_MS) return null;
    // Only the fields the wizard has somewhere to put. Anything else in an old
    // payload is dropped rather than spread into the answers.
    const out: HandedAddress = { propertyAddress: parsed.propertyAddress.trim() };
    if (typeof parsed.city === "string" && parsed.city) out.city = parsed.city;
    if (typeof parsed.state === "string" && parsed.state) out.state = parsed.state;
    if (typeof parsed.zip === "string" && parsed.zip) out.zip = parsed.zip;
    return out;
  } catch {
    return null;
  }
}
