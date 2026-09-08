/** Shared agency facts. Store facts in `AGENCY`; derive display formats below. */

export const AGENCY = {
  /** Legal entity name. Used on the ACORD producer block and legal pages. */
  name: "HOA Insurance Agency LLC",
  /** ACORD producer contact is the company, not an individual. */
  contactName: "HOA Insurance Agency LLC",
  /** Public founder identity. Kept separate from regulated-form contact data. */
  founderDisplayName: "Jake Greasley",
  founderLegalName: "Jacob Charles Greasley",
  founderJobTitle: "Founder and President",
  /** Consumer-facing brand of the legal entity, not a second licensed agency. */
  brandName: "ProtectMyHOA",
  /** Street + suite. ACORD keeps this on its own line, as does the footer. */
  addressLine1: "420 Lakeside Ave, Suite 202",
  /** ACORD has a discrete city field; the footer joins city/state/zip. */
  city: "Marlborough",
  /** Two-letter USPS code — ACORD's state field will not take a full name. */
  state: "MA",
  zip: "01752",
  /** Display format. Every machine format (tel:, E.164) is derived from it. */
  phone: "508-233-2261",
  /** General/service/claims address; also used on ACORD forms. */
  email: "insurance@ProtectMyHOA.com",
  /** Sales and website lead-delivery address. */
  leadEmail: "sales@ProtectMyHOA.com",
  /** Public marketing origin; paired with Astro's `site` setting. */
  site: "https://www.protectmyhoa.com",
  /** Branded display domain, without scheme or `www`. */
  siteLabel: "ProtectMyHOA.com",
  /** Strapline under the wordmark in the email signature. */
  tagline: "Insurance Built for Associations.",
  /** LLC formation date in ISO-8601 form. */
  foundingDate: "2025-12-30",
  /** Licensed footprint; carrier and product availability still varies. */
  areaServed: "all 50 states and the District of Columbia",
  /** Canonical organization description for metadata and structured data. */
  description:
    "ProtectMyHOA is the consumer-facing brand of HOA Insurance Agency LLC, an independent insurance agency based in Marlborough, Massachusetts, licensed and writing in all 50 states and the District of Columbia and specializing in coverage for homeowner and condominium associations.",
} as const;

/** Approved public profiles for the founder Person entity and About page. */
export const FOUNDER_PROFILES = [
  { label: "LinkedIn", url: "https://www.linkedin.com/in/jake-greasley" },
  { label: "Instagram", url: "https://www.instagram.com/jake.greasley/" },
  { label: "GitHub", url: "https://github.com/JakeGreasleyGIM" },
  {
    label: "eXp Realty profile",
    url: "https://ma.exprealty.com/agents/1903443/Jacob+Greasley",
  },
  {
    label: "Realtor member directory",
    url: "https://directories.apps.realtor/memberDetail/?personId=4940266&officeStreetCountry=US&memberLastName=Greasley",
  },
  {
    label: "Realtor.com profile",
    url: "https://www.realtor.com/realestateagents/656d3c88398ad2f645a8b94b",
  },
] as const;

const phoneDigits = AGENCY.phone.replace(/\D/g, "");

/**
 * Derived presentations of `AGENCY`. Computed, never hand-edited — every value
 * here is a pure function of the fields above.
 */
export const AGENCY_FMT = {
  /** City/state/zip joined the way the website footer prints it. */
  addressLine2: `${AGENCY.city}, ${AGENCY.state} ${AGENCY.zip}`,
  /** `tel:` href — E.164, no punctuation. */
  phoneHref: `tel:+1${phoneDigits}`,
  /** schema.org `telephone` format used in the JSON-LD blocks. */
  phoneIntl: `+1-${AGENCY.phone}`,
  /** `mailto:` href, canonical mixed-case spelling. */
  emailHref: `mailto:${AGENCY.email}`,
  /** Lowercase transport form, for URL paths and form-endpoint identifiers. */
  emailLower: AGENCY.email.toLowerCase(),
  /** `mailto:` href for the sales address, canonical mixed-case spelling. */
  leadEmailHref: `mailto:${AGENCY.leadEmail}`,
  /** Lowercase transport form of the sales address. */
  leadEmailLower: AGENCY.leadEmail.toLowerCase(),
  /** FormSubmit endpoint derived from the sales address. */
  formsubmitUrl: `https://formsubmit.co/ajax/${AGENCY.leadEmail.toLowerCase()}`,
  /** Trading name without the entity suffix, for signatures and letterheads. */
  displayName: AGENCY.name.replace(/\s+LLC$/, ""),
  /** Brand presentation for visible identity marks only, never structured data. */
  brandMarkedName: `${AGENCY.brandName}™`,
  /** Unmarked identity line for body copy and machine-adjacent contexts. */
  brandLine: `${AGENCY.brandName} is the consumer-facing brand of ${AGENCY.name}.`,
  /** Site href with the trailing slash links are written with. */
  siteHref: `${AGENCY.site}/`,
  /** Absolute logo URL. Email signatures cannot use a relative path. */
  logoUrl: `${AGENCY.site}/logo.png`,
} as const;

export type Agency = typeof AGENCY;
export type AgencyFormatted = typeof AGENCY_FMT;
