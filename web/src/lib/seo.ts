/** Canonical URL helpers and the site's connected structured-data graph. */

import { AGENCY, AGENCY_FMT, FOUNDER_PROFILES } from "../../../shared/agency";

/** Canonical origin; Astro config holds the required paired literal. */
export const SITE_ORIGIN = AGENCY.site;

/** Build an absolute, trailing-slash canonical URL for a route. */
export function canonicalUrl(path = ""): string {
  const trimmed = path.trim();
  if (trimmed === "" || trimmed === "/") return `${SITE_ORIGIN}/`;
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const withTrailing = withLeading.endsWith("/")
    ? withLeading
    : `${withLeading}/`;
  return `${SITE_ORIGIN}${withTrailing}`;
}

/** Absolute URL for a site-relative asset path; passes absolute URLs through. */
export function absoluteUrl(pathOrUrl: string): string {
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  return `${SITE_ORIGIN}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

/* Stable graph identifiers. The brand, website and people reference one agency. */

/** The agency. Referenced by every other node; never duplicated. */
export const ORG_ID = `${SITE_ORIGIN}/#organization`;
/** The consumer brand. A `Brand`, deliberately not a second agency. */
export const BRAND_ID = `${SITE_ORIGIN}/#brand`;
/** The website, whose publisher is the organization. */
export const WEBSITE_ID = `${SITE_ORIGIN}/#website`;

/**
 * The founder, as one person.
 *
 * Anchored to the About page section that names him, because that is where the
 * visible claim lives and structured data must not assert what the page does
 * not show.
 *
 * Keep the local anchor until https://jakegreasley.com/#person is live and
 * declares the apex host as canonical.
 */
export const FOUNDER_ID = `${SITE_ORIGIN}/about-us/#jake-greasley`;

/** The licensed producer named on /contact. */
export const SPECIALIST_ID = `${SITE_ORIGIN}/contact/#brian-cole`;

/** Approved organization identity profiles. */
const SOCIAL_PROFILES = [
  "https://www.instagram.com/hoainsuranceagency",
  "https://www.facebook.com/people/HOA-Insurance-Agency/61575377498498/",
  "https://www.linkedin.com/company/hoa-insurance-agency",
];

/** The sole agency node. The brand is an alternate name and separate Brand node. */
export function organizationSchema(): Record<string, unknown> {
  return {
    "@type": "InsuranceAgency",
    "@id": ORG_ID,
    name: AGENCY_FMT.displayName,
    legalName: AGENCY.name,
    alternateName: AGENCY.brandName,
    url: `${SITE_ORIGIN}/`,
    logo: {
      "@type": "ImageObject",
      "@id": `${SITE_ORIGIN}/#logo`,
      url: AGENCY_FMT.logoUrl,
      contentUrl: AGENCY_FMT.logoUrl,
      caption: AGENCY_FMT.displayName,
    },
    image: { "@id": `${SITE_ORIGIN}/#logo` },
    foundingDate: AGENCY.foundingDate,
    telephone: AGENCY_FMT.phoneIntl,
    email: AGENCY.email,
    address: {
      "@type": "PostalAddress",
      streetAddress: AGENCY.addressLine1,
      addressLocality: AGENCY.city,
      addressRegion: AGENCY.state,
      postalCode: AGENCY.zip,
      addressCountry: "US",
    },
    areaServed: { "@type": "Country", name: "United States" },
    description: AGENCY.description,
    brand: { "@id": BRAND_ID },
    founder: { "@id": FOUNDER_ID },
    sameAs: SOCIAL_PROFILES,
  };
}

/** Consumer brand node; regulated attributes remain on the agency. */
export function brandSchema(): Record<string, unknown> {
  return {
    "@type": "Brand",
    "@id": BRAND_ID,
    name: AGENCY.brandName,
    url: `${SITE_ORIGIN}/`,
    logo: AGENCY_FMT.logoUrl,
    parentOrganization: { "@id": ORG_ID },
  };
}

/** The website. Named for the brand, published by the agency. */
export function websiteSchema(): Record<string, unknown> {
  return {
    "@type": "WebSite",
    "@id": WEBSITE_ID,
    url: `${SITE_ORIGIN}/`,
    name: AGENCY.brandName,
    description: AGENCY.description,
    publisher: { "@id": ORG_ID },
    inLanguage: "en-US",
  };
}

/**
 * The founder Person uses founder-specific fields rather than ACORD contact data.
 */
export function personFounder(): Record<string, unknown> {
  return {
    "@type": "Person",
    "@id": FOUNDER_ID,
    name: AGENCY.founderDisplayName,
    alternateName: ["Jacob Greasley", AGENCY.founderLegalName],
    additionalName: "Charles",
    givenName: "Jacob",
    familyName: "Greasley",
    jobTitle: AGENCY.founderJobTitle,
    url: FOUNDER_ID,
    sameAs: FOUNDER_PROFILES.map((profile) => profile.url),
    worksFor: { "@id": ORG_ID },
  };
}

/** Create a page-bound FAQ node for inclusion in the shared graph. */
export function faqPageSchema(
  canonical: string,
  faqs: { q: string; a: string }[]
): Record<string, unknown> {
  return {
    "@type": "FAQPage",
    "@id": `${canonical}#faq`,
    mainEntityOfPage: { "@id": `${canonical}#webpage` },
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.q,
      acceptedAnswer: { "@type": "Answer", text: faq.a },
    })),
  };
}

/** Contact-page producer, using the same confirmed title as the visible card. */
export function personSpecialist(opts: {
  name: string;
  jobTitle: string;
  image?: string;
}): Record<string, unknown> {
  return {
    "@type": "Person",
    "@id": SPECIALIST_ID,
    name: opts.name,
    jobTitle: opts.jobTitle,
    url: SPECIALIST_ID,
    ...(opts.image ? { image: absoluteUrl(opts.image) } : {}),
    worksFor: { "@id": ORG_ID },
  };
}

/** The page itself, tied to the site and to the URL it claims as canonical. */
export function webPageSchema(opts: {
  canonical: string;
  title: string;
  description: string;
}): Record<string, unknown> {
  return {
    "@type": "WebPage",
    "@id": `${opts.canonical}#webpage`,
    url: opts.canonical,
    name: opts.title,
    description: opts.description,
    isPartOf: { "@id": WEBSITE_ID },
    about: { "@id": ORG_ID },
    publisher: { "@id": ORG_ID },
    inLanguage: "en-US",
  };
}

/** A breadcrumb trail. Paths are normalised through `canonicalUrl`. */
export function breadcrumbSchema(
  trail: { name: string; path: string }[]
): Record<string, unknown> {
  return {
    "@type": "BreadcrumbList",
    "@id": `${canonicalUrl(trail[trail.length - 1]?.path ?? "")}#breadcrumb`,
    itemListElement: trail.map((crumb, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: crumb.name,
      item: canonicalUrl(crumb.path),
    })),
  };
}

/** Build the connected graph; `extra` adds page-specific nodes. */
export function siteGraph(opts: {
  canonical: string;
  title: string;
  description: string;
  extra?: Record<string, unknown>[];
}): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@graph": [
      organizationSchema(),
      brandSchema(),
      websiteSchema(),
      webPageSchema(opts),
      personFounder(),
      ...(opts.extra ?? []),
    ],
  };
}
