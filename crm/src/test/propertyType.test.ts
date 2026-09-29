import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROPERTY_TYPES, PROPERTY_TYPE_LABELS, normalizePropertyType, accountPropertyType, propertyTypeLabel, webLeadPropertyType } from "../../../shared/propertyType";

describe("recorded property groups", () => {
  it("keeps the shared vocabulary aligned with the nullable Account schema field", () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    const schema = read("../../amplify/data/resource.ts");
    const declared = schema.match(/PropertyType: a\.enum\(\[([^\]]+)\]\)/)?.[1];
    expect([...declared!.matchAll(/"([A-Z_]+)"/g)].map(m => m[1])).toEqual(PROPERTY_TYPES);
    expect(schema).toContain('propertyType: a.ref("PropertyType"),');
    expect(Object.values(PROPERTY_TYPE_LABELS)).toEqual(["HOA / POA / pond / townhome HOA", "CONDO", "Individual unit owner", "Not recorded"]);
  });

  it("uses an explicit group and never derives an association subtype from its name", () => {
    const existing = { type: "ASSOCIATION", name: "Example Condominium Association" };
    expect(accountPropertyType(existing)).toBeNull();
    expect(propertyTypeLabel(accountPropertyType(existing))).toBe("Not recorded");
    expect(accountPropertyType({ ...existing, propertyType: "CONDO" })).toBe("CONDO");
    expect(accountPropertyType({ type: "PERSONAL" })).toBe("INDIVIDUAL_UNIT_OWNER");
    expect(accountPropertyType({ type: "COMMERCIAL_OTHER" })).toBeNull();
  });

  it("preserves an explicit unknown instead of restoring the PERSONAL fallback", () => {
    expect(accountPropertyType({ type: "PERSONAL", propertyType: "NOT_RECORDED" })).toBe("NOT_RECORDED");
    expect(accountPropertyType({ type: "ASSOCIATION", propertyType: "NOT_RECORDED" })).toBe("NOT_RECORDED");
    expect(propertyTypeLabel("NOT_RECORDED")).toBe("Not recorded");
    expect(accountPropertyType({ type: "PERSONAL", propertyType: null })).toBe("INDIVIDUAL_UNIT_OWNER");
  });

  it("maps only the website's confirmed property answers and preserves unknowns", () => {
    expect(webLeadPropertyType({ type: "ASSOCIATION", propertyKind: "condominium" })).toBe("CONDO");
    expect(webLeadPropertyType({ type: "ASSOCIATION", propertyKind: "other" })).toBe("HOA_POA_POND_TOWNHOME");
    expect(webLeadPropertyType({ type: "PERSONAL" })).toBe("INDIVIDUAL_UNIT_OWNER");
    for (const propertyKind of [undefined, null, "", "unknown", "Condominium Tower", "pond"]) expect(webLeadPropertyType({ type: "ASSOCIATION", propertyKind })).toBeNull();
    expect(webLeadPropertyType({ type: "COMMERCIAL_OTHER", propertyKind: "condominium" })).toBeNull();
  });

  it("accepts only enum values for manual storage", () => {
    for (const value of PROPERTY_TYPES) expect(normalizePropertyType(value)).toBe(value);
    for (const value of [null, undefined, "", "ASSOCIATION", "condo", "condominium", 1, {}]) expect(normalizePropertyType(value)).toBeNull();
  });
});
