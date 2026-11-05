/** State identities only. Page copy, map geometry and jurisdiction rules stay with their owners. */
const catalog = [
  { code: "AL", name: "Alabama" },
  { code: "AK", name: "Alaska" },
  { code: "AZ", name: "Arizona" },
  { code: "AR", name: "Arkansas" },
  { code: "CA", name: "California" },
  { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" },
  { code: "DE", name: "Delaware" },
  { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" },
  { code: "HI", name: "Hawaii" },
  { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" },
  { code: "IN", name: "Indiana" },
  { code: "IA", name: "Iowa" },
  { code: "KS", name: "Kansas" },
  { code: "KY", name: "Kentucky" },
  { code: "LA", name: "Louisiana" },
  { code: "ME", name: "Maine" },
  { code: "MD", name: "Maryland" },
  { code: "MA", name: "Massachusetts" },
  { code: "MI", name: "Michigan" },
  { code: "MN", name: "Minnesota" },
  { code: "MS", name: "Mississippi" },
  { code: "MO", name: "Missouri" },
  { code: "MT", name: "Montana" },
  { code: "NE", name: "Nebraska" },
  { code: "NV", name: "Nevada" },
  { code: "NH", name: "New Hampshire" },
  { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" },
  { code: "NY", name: "New York" },
  { code: "NC", name: "North Carolina" },
  { code: "ND", name: "North Dakota" },
  { code: "OH", name: "Ohio" },
  { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" },
  { code: "PA", name: "Pennsylvania" },
  { code: "RI", name: "Rhode Island" },
  { code: "SC", name: "South Carolina" },
  { code: "SD", name: "South Dakota" },
  { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" },
  { code: "UT", name: "Utah" },
  { code: "VT", name: "Vermont" },
  { code: "VA", name: "Virginia" },
  { code: "WA", name: "Washington" },
  { code: "WV", name: "West Virginia" },
  { code: "WI", name: "Wisconsin" },
  { code: "WY", name: "Wyoming" },
  { code: "DC", name: "District of Columbia" },
] as const;
export type USStateCode = typeof catalog[number]["code"];
export const US_STATE_CATALOG = Object.freeze(catalog.map(state => Object.freeze(state)));

/** Existing CRM option order: state names alphabetically, with DC last. */
export const US_STATES: readonly string[] = Object.freeze(catalog.map(state => state.code));
/** Existing map/name lookup order: alphabetical by USPS code. */
export const US_STATE_NAMES: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  [...catalog].sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0).map(state => [state.code, state.name]),
));
const codes = new Set<string>(US_STATES);
const aliases = new Map<string, USStateCode>(catalog.flatMap(state => [[state.code, state.code] as const, [state.name.toUpperCase(), state.code] as const]));

export function isUSStateCode(value: unknown): value is USStateCode {
  return typeof value === "string" && codes.has(value);
}

/** Account display/filter normalization; strict server membership uses isUSStateCode. */
export function usStateCode(value: string | null | undefined): USStateCode | "" {
  return aliases.get(value?.trim().toUpperCase() ?? "") ?? "";
}
