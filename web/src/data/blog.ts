/**
 * Journal categories, in the order the blog shows them. An article's `topic`
 * must be one of these names exactly; docs/BLOG-EDITORIAL-GUIDE.md says so,
 * and the listing files anything else after these.
 *
 * `cta` is the cross-page path each category sends readers toward.
 */
export const BLOG_CATEGORIES = [
  { name: "Master Policies", cta: { label: "Explore HOA Insurance", href: "/what-we-do/" } },
  { name: "D&O and Crime", cta: { label: "Explore HOA Insurance", href: "/what-we-do/" } },
  { name: "Liability & Umbrella", cta: { label: "Explore HOA Insurance", href: "/what-we-do/" } },
  { name: "Property & Catastrophe", cta: { label: "Explore condo association Insurance", href: "/condo-insurance/" } },
  { name: "Unit Owners (HO-6)", cta: { label: "Explore condo association Insurance", href: "/condo-insurance/" } },
  { name: "Market & Renewals", cta: { label: "Request Insurance Review", href: "/quote/" } },
  { name: "Laws & Compliance", cta: { label: "Talk with our team", href: "/contact/" } },
  { name: "Claims & Risk", cta: { label: "Talk with our team", href: "/contact/" } },
] as const;

const fallbackCta = { label: "Request Insurance Review", href: "/quote/" };
export const categoryCta = (topic: string) =>
  BLOG_CATEGORIES.find((c) => c.name === topic)?.cta ?? fallbackCta;

/** Known categories first, in their set order, then any other topic A–Z. */
export function orderTopics(topics: string[]): string[] {
  const known: string[] = BLOG_CATEGORIES.map((c) => c.name);
  const rank = (t: string) => (known.includes(t) ? known.indexOf(t) : known.length);
  return [...new Set(topics)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Every state, for the blog lead form. State articles may cover any of them. */
export const US_STATES = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"],
  ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"], ["DC", "District of Columbia"], ["FL", "Florida"],
  ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"],
  ["IA", "Iowa"], ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"],
  ["MD", "Maryland"], ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"],
  ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"], ["NH", "New Hampshire"],
  ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"], ["NC", "North Carolina"], ["ND", "North Dakota"],
  ["OH", "Ohio"], ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"],
  ["SC", "South Carolina"], ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"],
  ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"], ["WV", "West Virginia"], ["WI", "Wisconsin"],
  ["WY", "Wyoming"],
] as const;
