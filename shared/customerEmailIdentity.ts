import { AGENCY, AGENCY_FMT } from "./agency";

/** Customer correspondence follows the insured property's state, never a contact's address. */
export function customerEmailIdentity(propertyState?: string | null) {
  const california = /^(CA|California)$/i.test(propertyState?.trim() ?? "");
  return {
    california,
    name: california ? "Condo Insurance Agency" : AGENCY.name,
    displayName: california ? "Condo Insurance Agency" : AGENCY_FMT.displayName,
    disclosure: california
      ? "HOA Insurance Agency LLC does business in California as Condo Insurance Agency."
      : "",
  };
}

/** Apply only to agency-authored prose, not customer names, links, or payment facts. */
export function customerAgencyCopy(copy: string, propertyState?: string | null): string {
  if (!customerEmailIdentity(propertyState).california) return copy;
  return copy.replace(/\bHOA\s+Insurance\s+Agency(?:\s*,?\s+LLC)?\b/gi, "Condo Insurance Agency");
}
