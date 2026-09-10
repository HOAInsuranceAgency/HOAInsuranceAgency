/** Acquisition channel. Separate from AccountType (association / individual). */
export const LEAD_SOURCES = ["GOOGLE_AD_WEBSITE", "ORGANIC_WEBSITE", "PHONE", "EMAIL", "META_AD", "PROPERTY_MANAGER"] as const;
export type LeadSource = typeof LEAD_SOURCES[number];
export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  GOOGLE_AD_WEBSITE: "Google Ad Website", ORGANIC_WEBSITE: "Organic Website",
  PHONE: "Phone", EMAIL: "Email", META_AD: "Meta Ad", PROPERTY_MANAGER: "Property Manager",
};
export function isLeadSource(value: unknown): value is LeadSource {
  return typeof value === "string" && LEAD_SOURCES.includes(value as LeadSource);
}
export function acquisitionLabel(value: unknown, legacy?: string | null): string {
  if (isLeadSource(value)) return LEAD_SOURCE_LABELS[value];
  if (legacy?.toLowerCase().startsWith("website")) return "Website · attribution not recorded";
  return legacy?.trim() || "Not recorded";
}
export const ATTRIBUTION_KEYS = ["gclid", "gbraid", "wbraid", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "landingPath"] as const;
export type LeadAttribution = Partial<Record<typeof ATTRIBUTION_KEYS[number], string>>;
export function cleanAttribution(value: unknown): LeadAttribution {
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { value = {}; } }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(ATTRIBUTION_KEYS.flatMap(key => {
    const v = (value as Record<string, unknown>)[key];
    return typeof v === "string" && v.trim() ? [[key, v.trim().slice(0, 500)]] : [];
  }));
}
/** These are attribution signals, not proof of paid spend. Never infer ads
 * from a Google referrer or fbclid alone (ordinary shares can carry it). */
export function websiteLeadSource(value: unknown): LeadSource {
  const a = cleanAttribution(value);
  if (a.gclid || a.gbraid || a.wbraid) return "GOOGLE_AD_WEBSITE";
  const source = a.utm_source?.toLowerCase(), medium = a.utm_medium?.toLowerCase();
  const paid = /^(cpc|ppc|paid|paid[_ -]?social|paid[_ -]?search|display|cpm)$/.test(medium ?? "");
  if (paid && /^(google|googleads|google_ads|adwords)$/.test(source ?? "")) return "GOOGLE_AD_WEBSITE";
  if (paid && /^(meta|facebook|instagram|fb|ig)$/.test(source ?? "")) return "META_AD";
  return "ORGANIC_WEBSITE";
}
