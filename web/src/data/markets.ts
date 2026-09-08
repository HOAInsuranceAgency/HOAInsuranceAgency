/**
 * Owner-confirmed direct appointments with all twelve listed markets.
 * Logo-use permissions remain a separate, unconfirmed question.
 */
export interface Market {
  name: string;
  slug: string;
}

export const MARKETS: Market[] = [
  { name: "Amwins", slug: "amwins" },
  { name: "CAIS", slug: "cais" },
  { name: "Community Association Underwriters", slug: "community-association-underwriters" },
  { name: "CondoLogic", slug: "condologic" },
  { name: "Distinguished", slug: "distinguished" },
  { name: "Greater New York", slug: "greater-new-york" },
  { name: "Honeycomb", slug: "honeycomb" },
  { name: "LIO Insurance", slug: "lio-insurance" },
  { name: "McGowan", slug: "mcgowan" },
  { name: "Pathpoint", slug: "pathpoint" },
  { name: "RPS", slug: "rps" },
  { name: "Travelers", slug: "travelers" },
];
