/** Recorded property groups, separate from the CRM's broader account type. */
export const PROPERTY_TYPES = ["HOA_POA_POND_TOWNHOME", "CONDO", "INDIVIDUAL_UNIT_OWNER", "NOT_RECORDED"] as const;
export type PropertyType = typeof PROPERTY_TYPES[number];
export const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
  HOA_POA_POND_TOWNHOME: "HOA / POA / pond / townhome HOA",
  CONDO: "CONDO",
  INDIVIDUAL_UNIT_OWNER: "Individual unit owner",
  NOT_RECORDED: "Not recorded",
};
export function normalizePropertyType(value: unknown): PropertyType | null {
  return typeof value === "string" && PROPERTY_TYPES.includes(value as PropertyType) ? value as PropertyType : null;
}
export function propertyTypeLabel(value: unknown): string {
  const propertyType = normalizePropertyType(value);
  return propertyType ? PROPERTY_TYPE_LABELS[propertyType] : "Not recorded";
}
export function accountPropertyType(account: { propertyType?: unknown; type?: unknown } | Record<string, unknown>): PropertyType | null {
  // PERSONAL is explicitly Personal (HO-6) in the CRM's account-type contract.
  // An explicit NOT_RECORDED suppresses any fallback; absence allows one.
  // Association names and the broad ASSOCIATION type do not identify a subtype.
  return normalizePropertyType(account.propertyType) ?? (account.type === "PERSONAL" ? "INDIVIDUAL_UNIT_OWNER" : null);
}
export function webLeadPropertyType(input: { type?: unknown; propertyKind?: unknown }): PropertyType | null {
  if (input.type === "PERSONAL") return "INDIVIDUAL_UNIT_OWNER";
  if (input.type !== "ASSOCIATION") return null;
  if (input.propertyKind === "condominium") return "CONDO";
  // The website labels this exact answer "Other HOA / common areas only".
  if (input.propertyKind === "other") return "HOA_POA_POND_TOWNHOME";
  return null;
}
