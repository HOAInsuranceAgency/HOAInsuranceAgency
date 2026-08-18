/**
 * Google Places address autocomplete, loaded once and shared.
 *
 * Extracted from `InstantAssessment`, which had the only copy. The quote wizard
 * needs the same behaviour on its address field, and two copies of a script
 * loader racing to append the same `<script>` tag is how you end up with the
 * library initialised twice.
 *
 * Everything here degrades to nothing. No key, a blocked script, an offline
 * visitor: the input stays a plain text box that still accepts a typed address.
 * An address field that refuses to work because a third-party script did not
 * load would cost more than the autocomplete is worth.
 */

const GOOGLE_API_KEY = import.meta.env.PUBLIC_GOOGLE_PLACES_KEY || "";

/** Resolves once the Places library is usable, rejects if it will never be. */
export function loadGooglePlaces(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!GOOGLE_API_KEY) {
      reject(new Error("No Places key configured"));
      return;
    }
    if (window.google?.maps?.places) {
      resolve();
      return;
    }
    // Another component got here first. Wait on its tag rather than adding a
    // second one, which would load the library twice.
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src*="maps.googleapis.com"]'
    );
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Places failed to load")));
      return;
    }
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_API_KEY}&libraries=places`;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Places failed to load"));
    document.head.appendChild(s);
  });
}

/** The parts of a chosen place a lead form cares about. */
export interface ChosenPlace {
  /** Street line only, so it can sit in a field beside city and state. */
  address: string;
  city: string;
  /** Two-letter postal code, which is what the state select holds. */
  state: string;
  zip: string;
  /** The full one-line address, for a form with a single address field. */
  formatted: string;
}

function readComponents(place: google.maps.places.PlaceResult): ChosenPlace {
  const get = (type: string, short = false) => {
    const c = place.address_components?.find((x) => x.types.includes(type));
    return (short ? c?.short_name : c?.long_name) ?? "";
  };
  const streetNumber = get("street_number");
  const route = get("route");
  return {
    address: [streetNumber, route].filter(Boolean).join(" "),
    // `locality` is absent for some addresses; the town-level fallbacks are
    // what Massachusetts and much of New England actually return.
    city: get("locality") || get("sublocality") || get("administrative_area_level_2"),
    state: get("administrative_area_level_1", true).toUpperCase(),
    zip: get("postal_code"),
    formatted: place.formatted_address ?? "",
  };
}

/**
 * Attach autocomplete to an input. Returns a teardown, or null if Places is
 * unavailable — in which case the input is simply left alone.
 *
 * `onChoose` fires only when a visitor picks a suggestion, never on typing, so
 * a caller can safely use it to fill neighbouring fields.
 */
export function attachAddressAutocomplete(
  input: HTMLInputElement,
  onChoose: (place: ChosenPlace) => void
): (() => void) | null {
  if (!window.google?.maps?.places) return null;
  const ac = new google.maps.places.Autocomplete(input, {
    types: ["address"],
    componentRestrictions: { country: "us" },
    fields: ["address_components", "formatted_address"],
  });
  const listener = ac.addListener("place_changed", () => {
    const place = ac.getPlace();
    if (place?.address_components || place?.formatted_address) {
      onChoose(readComponents(place));
    }
  });
  return () => listener.remove();
}
